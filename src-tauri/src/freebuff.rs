//! Freebuff has no ACP, JSON-RPC or headless mode: its only interface is the
//! interactive terminal UI. MonoCode therefore runs the UI inside a private
//! pseudo-terminal, types turns into it, and reads the structured transcript
//! Freebuff itself persists under `~/.config/manicode/projects/<project>/chats`.
//!
//! The transcript is an implementation detail of Freebuff, so every field is
//! read defensively and a schema we do not understand fails loudly instead of
//! being presented as a reply. Nothing here invents a protocol.

use std::collections::HashMap;
use std::io::{Read, Write};
use std::path::{Component, Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use serde::Serialize;
use tauri::{AppHandle, Emitter, State};

use crate::dirs_home;

const DATA_EVENT: &str = "harness-freebuff-pty";
const EXIT_EVENT: &str = "harness-freebuff-exit";
const READ_CHUNK: usize = 16 * 1024;
/// One screen frame per emit at most; the adapter only needs text markers.
const PTY_COALESCE: Duration = Duration::from_millis(8);
/// A coding session's transcript includes Freebuff's own run state, which is
/// large. Refuse to pull anything bigger than this into the webview.
const MAX_CHAT_BYTES: u64 = 64 * 1024 * 1024;
const MAX_TOOL_OUTPUT_CHARS: usize = 16_000;
const TERMINAL_ROWS: u16 = 40;
const TERMINAL_COLS: u16 = 120;

#[cfg(windows)]
fn freebuff_pty_command(command: &str, args: &[String]) -> (String, Vec<String>) {
    let lower = command.to_ascii_lowercase();
    if !lower.ends_with(".cmd") && !lower.ends_with(".bat") {
        return (command.to_string(), args.to_vec());
    }

    // npm installs on Windows expose Freebuff as a `.cmd` shim. CreateProcessW
    // cannot launch that shell script directly; run it via cmd.exe so its Node
    // launcher can start the bundled Freebuff terminal binary.
    let inner_command = std::iter::once(format!("\"{}\"", command))
        .chain(args.iter().map(|argument| windows_cmd_argument(argument)))
        .collect::<Vec<_>>()
        .join(" ");
    // /S requires one outer quote pair around the /C command string when the
    // batch path itself is quoted (the canonical form is: cmd /s /c ""path" args").
    let command_line = format!("\"{inner_command}\"");
    (
        "cmd.exe".to_string(),
        vec!["/D".into(), "/S".into(), "/C".into(), command_line],
    )
}

#[cfg(windows)]
fn windows_cmd_argument(argument: &str) -> String {
    if argument.contains([' ', '\t', '"']) {
        format!("\"{}\"", argument.replace('"', "\\\""))
    } else {
        argument.to_string()
    }
}

#[cfg(all(test, windows))]
mod windows_launch_tests {
    use super::freebuff_pty_command;

    #[test]
    fn runs_npm_cmd_shim_through_cmd_with_original_cli_arguments() {
        let command = r"C:\Users\ROOT\AppData\Roaming\npm\freebuff.cmd";
        let args = vec![
            "--cwd".to_string(),
            r"C:\Users\ROOT\Music\monocode".to_string(),
            "--continue".to_string(),
            "2026-10-25T00-13-03.784Z".to_string(),
        ];

        let (program, wrapped_args) = freebuff_pty_command(command, &args);

        assert_eq!(program, "cmd.exe");
        assert_eq!(wrapped_args[..3], ["/D", "/S", "/C"]);
        assert_eq!(
            wrapped_args[3],
            format!("\"\"{command}\" --cwd \"{}\" --continue {}\"", args[1], args[3])
        );
    }

    #[test]
    fn keeps_native_executable_and_arguments_unchanged() {
        let command = r"C:\Program Files\Freebuff\freebuff.exe";
        let args = vec!["--continue".to_string(), "chat-id".to_string()];

        assert_eq!(
            freebuff_pty_command(command, &args),
            (command.to_string(), args)
        );
    }
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct FreebuffPtyData {
    session_id: String,
    data: String,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct FreebuffPtyExit {
    session_id: String,
    code: Option<i32>,
    pid: u32,
}

struct LivePty {
    writer: Mutex<Box<dyn Write + Send>>,
    pid: u32,
    #[cfg(unix)]
    master_fd: i32,
    #[cfg(windows)]
    _master: Mutex<Box<dyn portable_pty::MasterPty + Send>>,
}

pub struct FreebuffPtyHost {
    sessions: Mutex<HashMap<String, Arc<LivePty>>>,
}

impl FreebuffPtyHost {
    pub fn new() -> Self {
        Self {
            sessions: Mutex::new(HashMap::new()),
        }
    }

    fn insert(&self, id: String, live: Arc<LivePty>) -> Option<Arc<LivePty>> {
        self.sessions
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .insert(id, live)
    }

    fn take(&self, id: &str) -> Option<Arc<LivePty>> {
        self.sessions
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .remove(id)
    }

    fn get(&self, id: &str) -> Option<Arc<LivePty>> {
        self.sessions
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .get(id)
            .cloned()
    }

    fn take_if_pid(&self, id: &str, pid: u32) -> Option<Arc<LivePty>> {
        let mut sessions = self.sessions.lock().unwrap_or_else(|e| e.into_inner());
        if sessions.get(id).is_some_and(|live| live.pid == pid) {
            sessions.remove(id)
        } else {
            None
        }
    }

    pub(crate) fn kill_all(&self) {
        let all: Vec<Arc<LivePty>> = {
            let mut sessions = self.sessions.lock().unwrap_or_else(|e| e.into_inner());
            sessions.drain().map(|(_, live)| live).collect()
        };
        let pids: Vec<u32> = all.iter().map(|live| live.pid).collect();
        #[cfg(unix)]
        for live in &all {
            crate::pty::close_fd(live.master_fd);
        }
        drop(all);
        crate::harness::terminate_all(&pids);
    }
}

impl Drop for FreebuffPtyHost {
    fn drop(&mut self) {
        self.kill_all();
    }
}

/// Freebuff stores each chat under this project directory. It derives it from
/// `path.basename(cwd)`, so a drive or filesystem root maps to no segment.
fn project_key(cwd: &Path) -> String {
    match cwd.components().next_back() {
        Some(Component::Normal(name)) => name.to_string_lossy().into_owned(),
        _ => String::new(),
    }
}

fn config_dir() -> Result<PathBuf, String> {
    // The CLI honours an absolute FREEBUFF_CONFIG_DIR and otherwise uses
    // `~/.config/manicode` (same layout as the Claude Code installer). Read the
    // same choice so the transcript path is the one the child writes.
    if let Some(dir) = std::env::var_os("FREEBUFF_CONFIG_DIR") {
        let path = PathBuf::from(dir);
        if !path.is_absolute() {
            return Err(
                "FREEBUFF_CONFIG_DIR must be an absolute path so Freebuff sessions can be found."
                    .into(),
            );
        }
        return Ok(path);
    }
    let home = dirs_home().ok_or_else(|| "Could not resolve the home directory".to_string())?;
    Ok(Path::new(&home).join(".config").join("manicode"))
}

fn valid_chat_id(chat_id: &str) -> bool {
    !chat_id.is_empty()
        && chat_id.len() <= 120
        && chat_id != "."
        && chat_id != ".."
        && chat_id
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_' | b'.' | b':'))
}

fn chat_path(cwd: &str, chat_id: &str) -> Result<PathBuf, String> {
    if !valid_chat_id(chat_id) {
        return Err("Invalid Freebuff conversation id.".into());
    }
    let workdir = crate::fs::expand_home(cwd.trim());
    if !workdir.is_absolute() {
        return Err("Freebuff needs an absolute working directory.".into());
    }
    Ok(config_dir()?
        .join("projects")
        .join(project_key(&workdir))
        .join("chats")
        .join(chat_id))
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PreparedChat {
    path: String,
    created: bool,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ChatSnapshot {
    messages: Vec<ChatMessage>,
    size: u64,
    mtime_ms: u64,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct ChatMessage {
    id: String,
    variant: String,
    content: String,
    is_complete: Option<bool>,
    completion_time: Option<String>,
    blocks: Vec<ChatBlock>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct ChatBlock {
    #[serde(rename = "type")]
    kind: String,
    text_type: Option<String>,
    content: Option<String>,
    tool_call_id: Option<String>,
    tool_name: Option<String>,
    input: Option<serde_json::Value>,
    output: Option<String>,
}

fn json_string(value: &serde_json::Value, key: &str) -> Option<String> {
    value
        .get(key)
        .and_then(|field| field.as_str())
        .map(str::to_string)
}

fn truncated(value: &str) -> String {
    let mut text: String = value.chars().take(MAX_TOOL_OUTPUT_CHARS).collect();
    if text.chars().count() < value.chars().count() {
        text.push('…');
    }
    text
}

/// The handful of fields MonoCode renders, projected out of a transcript that
/// also carries Freebuff's multi-megabyte run state.
fn project_chat(raw: &str) -> Result<Vec<ChatMessage>, String> {
    let root: serde_json::Value = serde_json::from_str(raw)
        .map_err(|_| "Freebuff is still writing its chat transcript.".to_string())?;
    let items = root
        .as_array()
        .ok_or_else(|| "Freebuff chat transcript is not a message list.".to_string())?;
    let mut messages = Vec::with_capacity(items.len());
    for item in items {
        let variant = json_string(item, "variant").unwrap_or_default();
        if variant != "user" && variant != "ai" {
            continue;
        }
        let blocks = item
            .get("blocks")
            .and_then(|value| value.as_array())
            .map(|blocks| {
                blocks
                    .iter()
                    .filter_map(|block| {
                        let kind = json_string(block, "type")?;
                        Some(ChatBlock {
                            kind,
                            text_type: json_string(block, "textType"),
                            content: json_string(block, "content"),
                            tool_call_id: json_string(block, "toolCallId"),
                            tool_name: json_string(block, "toolName"),
                            input: block.get("input").cloned(),
                            output: block
                                .get("output")
                                .and_then(|output| output.as_str())
                                .map(truncated),
                        })
                    })
                    .collect()
            })
            .unwrap_or_default();
        messages.push(ChatMessage {
            id: json_string(item, "id").unwrap_or_default(),
            variant,
            content: json_string(item, "content").unwrap_or_default(),
            is_complete: item.get("isComplete").and_then(|value| value.as_bool()),
            completion_time: json_string(item, "completionTime"),
            blocks,
        });
    }
    Ok(messages)
}

fn read_chat_file(path: &Path) -> Result<ChatSnapshot, String> {
    let missing = || ChatSnapshot {
        messages: Vec::new(),
        size: 0,
        mtime_ms: 0,
    };
    let meta = match std::fs::metadata(path) {
        Ok(meta) => meta,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(missing()),
        Err(error) => return Err(format!("Could not read the Freebuff chat: {error}")),
    };
    if !meta.is_file() {
        return Ok(missing());
    }
    if meta.len() > MAX_CHAT_BYTES {
        return Err(format!(
            "The Freebuff chat transcript is too large to read (maximum {} MB).",
            MAX_CHAT_BYTES / 1024 / 1024
        ));
    }
    let bytes = std::fs::read(path)
        .map_err(|error| format!("Could not read the Freebuff chat: {error}"))?;
    let raw = String::from_utf8(bytes)
        .map_err(|_| "Freebuff chat transcript is not valid UTF-8.".to_string())?;
    let mtime_ms = meta
        .modified()
        .ok()
        .and_then(|time| time.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|elapsed| elapsed.as_millis() as u64)
        .unwrap_or(0);
    Ok(ChatSnapshot {
        messages: project_chat(&raw)?,
        size: meta.len(),
        mtime_ms,
    })
}

/// Create the chat directory Freebuff will resume, so a MonoCode session owns a
/// stable conversation id instead of racing another chat for the newest folder.
#[tauri::command]
pub async fn harness_freebuff_prepare_chat(
    cwd: String,
    chat_id: String,
) -> Result<PreparedChat, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let dir = chat_path(&cwd, &chat_id)?;
        std::fs::create_dir_all(&dir)
            .map_err(|error| format!("Could not create the Freebuff chat folder: {error}"))?;
        let messages = dir.join("chat-messages.json");
        let created = !messages.exists();
        if created {
            std::fs::write(&messages, "[]")
                .map_err(|error| format!("Could not prepare the Freebuff chat: {error}"))?;
            #[cfg(unix)]
            {
                use std::os::unix::fs::PermissionsExt;
                let _ = std::fs::set_permissions(&messages, std::fs::Permissions::from_mode(0o600));
            }
        }
        Ok(PreparedChat {
            path: messages.to_string_lossy().into_owned(),
            created,
        })
    })
    .await
    .map_err(|error| error.to_string())?
}

/// Read the persisted Freebuff transcript, projected to what MonoCode renders.
#[tauri::command]
pub async fn harness_freebuff_read_chat(
    cwd: String,
    chat_id: String,
) -> Result<ChatSnapshot, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let dir = chat_path(&cwd, &chat_id)?;
        read_chat_file(&dir.join("chat-messages.json"))
    })
    .await
    .map_err(|error| error.to_string())?
}

/// Spawn Freebuff's TUI inside a private PTY. Arguments are built here, never
/// accepted from the webview, so a path or chat id cannot become a CLI flag.
#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub fn harness_freebuff_pty_spawn(
    app: AppHandle,
    host: State<'_, FreebuffPtyHost>,
    session_id: String,
    command: String,
    binary_path: Option<String>,
    cwd: String,
    chat_id: String,
) -> Result<u32, String> {
    if !crate::harness::is_resolved_harness_binary(
        &command,
        Some("freebuff"),
        binary_path.as_deref(),
    ) {
        return Err("Freebuff PTY: not a resolved Freebuff binary.".into());
    }
    if !valid_chat_id(&chat_id) {
        return Err("Invalid Freebuff conversation id.".into());
    }
    let workdir = crate::fs::expand_home(&cwd);
    if !workdir.is_dir() {
        return Err(format!(
            "Working directory does not exist: {}",
            workdir.display()
        ));
    }
    // Resuming an explicit chat keeps each MonoCode session separate even when
    // several Freebuff windows run in the same project.
    let args = vec![
        "--cwd".to_string(),
        cwd.clone(),
        "--continue".to_string(),
        chat_id,
    ];
    if let Some(previous) = host.take(&session_id) {
        crate::harness::terminate(previous.pid);
        #[cfg(unix)]
        crate::pty::close_fd(previous.master_fd);
    }
    pty::spawn(&app, &host, &session_id, &command, &args, &workdir)
}

#[tauri::command]
pub fn harness_freebuff_pty_write(
    host: State<'_, FreebuffPtyHost>,
    session_id: String,
    data: String,
) -> Result<(), String> {
    let live = host
        .get(&session_id)
        .ok_or_else(|| "Freebuff is not running for this session.".to_string())?;
    let mut writer = live.writer.lock().unwrap_or_else(|e| e.into_inner());
    writer
        .write_all(data.as_bytes())
        .and_then(|_| writer.flush())
        .map_err(|error| format!("Could not write to Freebuff: {error}"))
}

#[tauri::command]
pub fn harness_freebuff_pty_kill(
    host: State<'_, FreebuffPtyHost>,
    session_id: String,
) -> Result<(), String> {
    if let Some(live) = host.take(&session_id) {
        crate::harness::terminate(live.pid);
        #[cfg(unix)]
        crate::pty::close_fd(live.master_fd);
    }
    Ok(())
}

#[tauri::command]
pub fn harness_freebuff_pty_kill_all(host: State<'_, FreebuffPtyHost>) -> Result<(), String> {
    host.kill_all();
    Ok(())
}

fn emit_data(app: &AppHandle, session_id: &str, bytes: &[u8]) {
    if bytes.is_empty() {
        return;
    }

    let text = String::from_utf8_lossy(bytes);
    app.emit(
        DATA_EVENT,
        FreebuffPtyData {
            session_id: session_id.to_owned(),
            data: text.into_owned(),
        },
    )
    .ok();
}

fn emit_exit(app: &AppHandle, session_id: &str, code: Option<i32>, pid: u32) {
    app.emit(
        EXIT_EVENT,
        FreebuffPtyExit {
            session_id: session_id.to_owned(),
            code,
            pid,
        },
    )
    .ok();
}

#[cfg(unix)]
mod pty {
    use super::*;
    use std::fs::File;
    use std::os::fd::{AsRawFd, FromRawFd, OwnedFd};
    use std::os::unix::process::CommandExt;
    use std::thread;

    pub(crate) fn spawn(
        app: &AppHandle,
        host: &State<'_, FreebuffPtyHost>,
        session_id: &str,
        command: &str,
        args: &[String],
        workdir: &Path,
    ) -> Result<u32, String> {
        let (master, slave) = crate::pty::open_pty(TERMINAL_COLS, TERMINAL_ROWS)?;
        let master = unsafe { OwnedFd::from_raw_fd(master) };
        let slave = unsafe { OwnedFd::from_raw_fd(slave) };
        crate::pty::set_cloexec(master.as_raw_fd());

        let reader = unsafe { File::from_raw_fd(crate::pty::dup_fd(master.as_raw_fd())?) };
        let writer = unsafe { File::from_raw_fd(crate::pty::dup_fd(master.as_raw_fd())?) };
        let mut cmd = std::process::Command::new(command);
        cmd.args(args)
            .current_dir(workdir)
            .stdin(crate::pty::dup_stdio(slave.as_raw_fd())?)
            .stdout(crate::pty::dup_stdio(slave.as_raw_fd())?)
            .stderr(crate::pty::dup_stdio(slave.as_raw_fd())?)
            .env("PATH", crate::harness::gui_search_path())
            .env("PWD", workdir)
            .env("TERM", "xterm-256color")
            .env("COLORTERM", "truecolor")
            .env("COLORFGBG", "15;0")
            .env("TERM_PROGRAM", "MonoCode");
        if let Some(home) = dirs_home() {
            cmd.env("HOME", &home);
        }
        if let Some(config_dir) = std::env::var_os("FREEBUFF_CONFIG_DIR") {
            cmd.env("FREEBUFF_CONFIG_DIR", config_dir);
        }
        crate::harness::prepare_pty_child(&mut cmd, command);
        let slave_fd = slave.as_raw_fd();
        unsafe {
            cmd.pre_exec(move || {
                if libc::setsid() < 0 {
                    return Err(std::io::Error::last_os_error());
                }
                let _ = libc::ioctl(0, libc::TIOCSCTTY as _, 0);
                if slave_fd > 2 {
                    libc::close(slave_fd);
                }
                Ok(())
            });
        }
        let mut child = cmd
            .spawn()
            .map_err(|error| format!("Failed to start Freebuff: {error}"))?;
        drop(slave);
        let pid = child.id();
        let master_fd = master.as_raw_fd();
        let live = Arc::new(LivePty {
            writer: Mutex::new(Box::new(writer)),
            pid,
            master_fd,
        });
        if let Some(previous) = host.insert(session_id.to_owned(), live) {
            crate::harness::terminate(previous.pid);
            crate::pty::close_fd(previous.master_fd);
        }
        std::mem::forget(master);

        let data_app = app.clone();
        let data_id = session_id.to_owned();
        thread::spawn(move || {
            let mut reader = reader;
            let mut buffer = vec![0; READ_CHUNK];
            loop {
                match reader.read(&mut buffer) {
                    Ok(0) => break,
                    Ok(length) => emit_data(&data_app, &data_id, &buffer[..length]),
                    Err(error) if error.kind() == std::io::ErrorKind::Interrupted => continue,
                    Err(_) => break,
                }
            }
        });

        let wait_app = app.clone();
        let wait_id = session_id.to_owned();
        thread::spawn(move || {
            let code = child.wait().ok().and_then(|status| status.code());
            if let Some(host) = wait_app.try_state::<FreebuffPtyHost>() {
                if let Some(live) = host.take_if_pid(&wait_id, pid) {
                    crate::pty::close_fd(live.master_fd);
                    emit_exit(&wait_app, &wait_id, code, pid);
                }
            }
        });
        Ok(pid)
    }
}

#[cfg(windows)]
mod pty {
    use super::*;
    use portable_pty::{native_pty_system, CommandBuilder, PtySize};
    use std::thread;
    use tauri::Manager;

    pub(crate) fn spawn(
        app: &AppHandle,
        host: &State<'_, FreebuffPtyHost>,
        session_id: &str,
        command: &str,
        args: &[String],
        workdir: &Path,
    ) -> Result<u32, String> {
        let system = native_pty_system();
        let pair = system
            .openpty(PtySize {
                rows: TERMINAL_ROWS,
                cols: TERMINAL_COLS,
                pixel_width: 0,
                pixel_height: 0,
            })
            .map_err(|error| format!("Failed to open Freebuff terminal: {error}"))?;
        let (program, child_args) = freebuff_pty_command(command, args);
        let mut builder = CommandBuilder::new(program);
        builder.args(child_args);
        builder.cwd(workdir);
        builder.env("PATH", crate::harness::gui_search_path());
        builder.env("TERM", "xterm-256color");
        builder.env("COLORTERM", "truecolor");
        builder.env("COLORFGBG", "15;0");
        builder.env("TERM_PROGRAM", "MonoCode");
        if let Some(home) = dirs_home() {
            builder.env("HOME", &home);
            builder.env("USERPROFILE", &home);
        }
        if let Some(config_dir) = std::env::var_os("FREEBUFF_CONFIG_DIR") {
            builder.env("FREEBUFF_CONFIG_DIR", config_dir);
        }
        crate::harness::prepare_pty_builder(&mut builder, command);
        builder.env("PATHEXT", ".COM;.EXE;.BAT;.CMD");
        let writer = pair
            .master
            .take_writer()
            .map_err(|error| format!("Could not open Freebuff terminal input: {error}"))?;
        let reader = pair
            .master
            .try_clone_reader()
            .map_err(|error| format!("Could not open Freebuff terminal output: {error}"))?;
        let mut child = crate::windows::spawn_pty(pair.slave.as_ref(), builder)
            .map_err(|error| format!("Failed to start Freebuff: {error}"))?;
        let Some(pid) = child.process_id() else {
            let _ = child.kill();
            let _ = child.wait();
            return Err("Could not identify the Freebuff process.".to_string());
        };
        let live = Arc::new(LivePty {
            writer: Mutex::new(writer),
            pid,
            _master: Mutex::new(pair.master),
        });
        if let Some(previous) = host.insert(session_id.to_owned(), live) {
            crate::harness::terminate(previous.pid);
        }

        let data_app = app.clone();
        let data_id = session_id.to_owned();
        thread::spawn(move || {
            let mut reader = reader;
            let mut buffer = vec![0; READ_CHUNK];
            loop {
                match reader.read(&mut buffer) {
                    Ok(0) => break,
                    Ok(length) => {
                        thread::sleep(PTY_COALESCE);
                        emit_data(&data_app, &data_id, &buffer[..length]);
                    }
                    Err(error) if error.kind() == std::io::ErrorKind::Interrupted => continue,
                    Err(_) => break,
                }
            }
        });

        let wait_app = app.clone();
        let wait_id = session_id.to_owned();
        thread::spawn(move || {
            let code = child.wait().ok().map(|status| status.exit_code() as i32);
            if let Some(host) = wait_app.try_state::<FreebuffPtyHost>() {
                if host.take_if_pid(&wait_id, pid).is_some() {
                    emit_exit(&wait_app, &wait_id, code, pid);
                }
            }
        });
        Ok(pid)
    }
}

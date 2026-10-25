import { useSyncExternalStore } from "react";
import { openUrl } from "@tauri-apps/plugin-opener";
import {
  FREEBUFF_ACCOUNT_URL,
  FREEBUFF_PLANS_URL,
  getFreebuffAccountSnapshot,
  refreshFreebuffAccount,
  subscribeFreebuffAccount,
  type Observed,
} from "../model/freebuffAccount";
import { barClass } from "./ProviderAccountUsage";
import { ExternalLink, RefreshCw } from "../../../shared/ui/icons";

function StatusDot({ tone }: { tone: "ready" | "warn" | "bad" | "idle" }) {
  const color =
    tone === "ready"
      ? "bg-emerald-400"
      : tone === "warn"
        ? "bg-amber-400"
        : tone === "bad"
          ? "bg-red-400"
          : "bg-content/25";
  return (
    <span className={`size-1.5 shrink-0 rounded-full ${color}`} aria-hidden />
  );
}

function Note({ entry }: { entry: Observed<unknown> }) {
  if (entry.state === "available" || !entry.reason) return null;
  return (
    <span
      className={
        entry.state === "error" ? "text-red-400/90" : "text-content/40"
      }
    >
      {entry.reason}
    </span>
  );
}

function Line({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <div className="flex items-start gap-6 border-b border-content/5 px-4 py-3 last:border-b-0">
      <div className="w-36 shrink-0 text-[12px] text-content/45">{label}</div>
      <div className="min-w-0 flex-1 text-[12px] leading-relaxed text-content/75">
        {children}
      </div>
    </div>
  );
}

function Link({ href, children }: { href: string; children: React.ReactNode }) {
  return (
    <button
      type="button"
      onClick={() => void openUrl(href).catch(() => undefined)}
      className="inline-flex items-center gap-1 text-accent hover:underline"
    >
      {children}
      <ExternalLink className="size-3" strokeWidth={1.75} />
    </button>
  );
}

/**
 * What Freebuff actually tells us. Values are read from the PTY of a real
 * MonoCode session; no second CLI is started and no usage is inferred.
 */
export function FreebuffAccountPanel() {
  const account = useSyncExternalStore(
    subscribeFreebuffAccount,
    getFreebuffAccountSnapshot,
  );

  const hours = account.dailyHours.value;
  const usedPercent = hours
    ? Math.min(
        100,
        Math.max(0, ((hours.limit - hours.remaining) / hours.limit) * 100),
      )
    : null;
  const signedIn = account.signedIn.value;
  const models = account.models.value ?? [];
  const checked = account.checkedAt
    ? new Date(account.checkedAt).toLocaleTimeString([], {
        hour: "2-digit",
        minute: "2-digit",
      })
    : null;

  return (
    <section className="pt-8" data-testid="freebuff-account">
      <div className="flex items-end gap-4 pb-2.5">
        <div className="min-w-0 flex-1">
          <h2 className="text-[13px] font-semibold text-content">
            Freebuff account
          </h2>
          <p className="mt-1 text-[12px] leading-relaxed text-content/45">
            Freebuff exposes no account API to other apps. MonoCode reads what
            its terminal prints, names what it cannot read, and never estimates
            usage from your conversations.
          </p>
        </div>
        <button
          type="button"
          disabled={account.probing}
          aria-busy={account.probing}
          onClick={() => void refreshFreebuffAccount({ force: true })}
          aria-label="Check Freebuff CLI"
          title="Check Freebuff CLI"
          className="mb-0.5 grid size-7 shrink-0 place-items-center rounded-md text-content/40 transition-transform duration-150 hover:bg-content/10 hover:text-content active:scale-[0.96] disabled:opacity-40"
        >
          <RefreshCw
            className={`size-3.5 ${account.probing ? "animate-spin" : ""}`}
            strokeWidth={1.75}
          />
        </button>
      </div>

      <div className="overflow-hidden rounded-xl border border-content/10 bg-content/3">
        <Line label="Connection">
          <div className="flex flex-wrap items-center gap-2">
            <StatusDot
              tone={
                signedIn === true
                  ? "ready"
                  : signedIn === false
                    ? "bad"
                    : "idle"
              }
            />
            <span>
              {signedIn === true
                ? "Signed in"
                : signedIn === false
                  ? "Not signed in"
                  : "Not confirmed"}
            </span>
            <Note entry={account.signedIn} />
          </div>
        </Line>

        <Line label="Plan">
          <div className="flex flex-wrap items-center gap-2">
            <span>Not exposed by the Freebuff CLI</span>
            <Link href={FREEBUFF_ACCOUNT_URL}>Account page</Link>
          </div>
          <Note entry={account.plan} />
        </Line>

        <Line label="Hourly balance">
          {hours ? (
            <>
              <div className="flex items-baseline justify-between gap-3">
                <span className="tabular-nums">
                  {hours.remaining} / {hours.limit} h remaining
                </span>
                <span className="text-[11px] text-content/40">
                  {account.sessionLeftMinutes.value != null
                    ? `${account.sessionLeftMinutes.value} min left in this session`
                    : "session time not shown"}
                </span>
              </div>
              {usedPercent != null ? (
                <div
                  className="mt-2 h-1 overflow-hidden rounded-full bg-content/10"
                  role="progressbar"
                  aria-label="Freebuff hourly balance used"
                  aria-valuemin={0}
                  aria-valuemax={100}
                  aria-valuenow={Math.round(usedPercent)}
                >
                  <span
                    className={`block h-full rounded-full ${barClass(usedPercent)}`}
                    style={{ width: `${usedPercent}%` }}
                  />
                </div>
              ) : null}
              <p className="mt-1.5 text-[11px] text-content/40">
                Reset time is not printed by Freebuff.
              </p>
            </>
          ) : (
            <>
              <span>Not available</span>
              <Note entry={account.dailyHours} />
            </>
          )}
        </Line>

        <Line label="Context">
          {account.context.value ? (
            <div className="flex flex-wrap items-center gap-2">
              <span className="tabular-nums">
                {account.context.value.label} used ({account.context.value.percent}%)
              </span>
              <span className="text-[11px] text-content/40">
                conversation context — not account tokens; maximum capacity not reported
              </span>
            </div>
          ) : (
            <>
              <span>Not available</span>
              <Note entry={account.context} />
            </>
          )}
        </Line>

        <Line label="Model in use">
          {account.model.value ? (
            <span>
              {account.model.value.name}
              {account.model.value.effort
                ? ` · ${account.model.value.effort}`
                : ""}
            </span>
          ) : (
            <>
              <span>Not available</span>
              <Note entry={account.model} />
            </>
          )}
        </Line>

        <Line label="Model selection">
          <div className="flex flex-wrap items-center gap-2">
            <span>Use the MonoCode model picker to read and change Freebuff&apos;s visible <code>/model</code> choices.</span>
            <Note entry={account.modelControl} />
          </div>
        </Line>

        <Line label="Models listed">
          {models.length > 0 ? (
            <>
              <p className="text-[11px] text-content/40">
                {models.length} models were visible in Freebuff&apos;s own picker
                at check time (it may list more below the fold). MonoCode reads
                those choices and applies a selection through the active Freebuff
                terminal, then waits for the CLI to confirm the active model.
              </p>
              <ul className="mt-2 flex flex-wrap gap-1.5">
                {models.map((model) => (
                  <li
                    key={model.name}
                    className={`rounded-md border px-2 py-1 text-[11px] ${
                      model.selected
                        ? "border-accent/40 bg-accent/10 text-content/80"
                        : "border-content/10 text-content/55"
                    }`}
                    title={model.descriptors.join(" · ") || undefined}
                  >
                    {model.name}
                    {model.effort ? ` · ${model.effort}` : ""}
                    {model.selected ? " (current)" : ""}
                  </li>
                ))}
              </ul>
            </>
          ) : (
            <span>
              Not available from the CLI; use Freebuff&apos;s /model picker.
            </span>
          )}
        </Line>

        <Line label="Tokens and credits">
          <div className="flex flex-wrap items-center gap-2">
            <span>Not exposed</span>
            <Link href={FREEBUFF_PLANS_URL}>Plans page</Link>
          </div>
          <Note entry={account.accountTokens} />
        </Line>
      </div>

      <div className="mt-2 flex flex-wrap items-center gap-2 text-[11px] text-content/35">
        <span>
          {checked
            ? `Checked at ${checked} · source: Freebuff terminal`
            : "Not checked yet"}
        </span>
        {account.version.value ? (
          <span>· Freebuff {account.version.value}</span>
        ) : account.error ? (
          <span>· Freebuff version unavailable</span>
        ) : null}
        {account.error ? (
          <span className="text-red-400/90">· {account.error}</span>
        ) : null}
      </div>
    </section>
  );
}

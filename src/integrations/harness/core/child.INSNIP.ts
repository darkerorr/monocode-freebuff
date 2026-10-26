function dispatchFreebuffModelControl(
  request: FreebuffPtyModelControlRequest,
  unavailableMessage: string,
): void {
  if (freebuffPtyModelControlSubscribers.size === 0) {
    request.reject(new Error("Freebuff model control is not available."));
    return;
  }
  let accepted = false;
  for (const subscriber of freebuffPtyModelControlSubscribers) {
    try {
      accepted = subscriber(request) || accepted;
    } catch (error) {
      request.reject(error instanceof Error ? error : new Error(String(error)));
    }
  }
  if (!accepted) request.reject(new Error(unavailableMessage));
}

export function requestFreebuffModelChange(
  sessionId: string,
  modelName: string,
): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    dispatchFreebuffModelControl(
      { sessionId, action: "select", data: modelName, resolve, reject },
      "No active Freebuff PTY accepted the model change.",
    );
  });
}
export function requestFreebuffModelChoices(
  sessionId: string,
): Promise<FreebuffModelChoice[]> {
  return new Promise<FreebuffModelChoice[]>((resolve, reject) => {
    dispatchFreebuffModelControl(
      { sessionId, action: "list", resolve, reject },
      "No active Freebuff PTY accepted the model-list request.",
    );
  });
}
export function requestFreebuffActiveModel(
  sessionId: string,
): Promise<{ name: string; effort: string } | null> {
  return new Promise<{ name: string; effort: string } | null>((resolve, reject) => {
    dispatchFreebuffModelControl(
      { sessionId, action: "activeModel", resolve, reject },
      "No active Freebuff PTY accepted the active-model request.",
    );
  });
}

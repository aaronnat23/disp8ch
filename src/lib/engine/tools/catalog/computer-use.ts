import type { ToolDefinition } from "../types";

export const COMPUTER_USE_TOOL_CATALOG: Record<string, ToolDefinition> = {
  take_screenshot: {
    name: "take_screenshot",
    description: "Take a screenshot of the current desktop screen. Saves to a file and returns the path.",
    parameters: {
      type: "object",
      properties: {
        output_path: {
          type: "string",
          description: "Where to save the screenshot. Defaults to a temp file.",
        },
      },
      required: [],
    },
  },

  computer_observe: {
    name: "computer_observe",
    description:
      "Observe the local desktop through the optional Cua driver. " +
      "Use for native apps, browser chrome, or operating-system UI. For webpage content and forms, prefer browser_snapshot and browser tools. " +
      "Pass the visible window title in app_hint so the first call can resolve and capture the exact window. " +
      "Read-only, but may capture private screen contents.",
    parameters: {
      type: "object",
      properties: {
        session_id: { type: "string", description: "Optional existing computer-use session id. Omit to reuse this chat's active session." },
        app_hint: { type: "string", description: "Visible application name or window title. The adapter resolves and captures the best native-window match in this call." },
        pid: { type: "number", description: "Target process id. Omit with window_id to list visible windows first." },
        window_id: { type: "number", description: "Target window id. When supplied with pid, captures that exact window." },
        mode: { type: "string", enum: ["som", "vision", "ax"], description: "som returns bounded elements plus screenshot, vision screenshot only, ax accessibility elements only. Defaults to som." },
        query: { type: "string", description: "Optional label substring for filtering the rendered accessibility tree." },
        max_elements: { type: "number", description: "Bound accessibility results. Defaults to 200, maximum 500." },
        max_depth: { type: "number", description: "Bound accessibility-tree depth. Defaults to 20, maximum 40." },
      },
      required: [],
    },
  },

  computer_list_apps: {
    name: "computer_list_apps",
    description: "List running and installed desktop applications through Cua. Use this before launching or focusing an app when its pid or launch identity is unknown.",
    parameters: { type: "object", properties: { session_id: { type: "string", description: "Optional existing computer-use session id." } }, required: [] },
  },

  computer_launch_app: {
    name: "computer_launch_app",
    description: "Launch a desktop application without stealing focus when supported. Requires human approval.",
    parameters: {
      type: "object",
      properties: {
        session_id: { type: "string", description: "Optional existing computer-use session id." },
        name: { type: "string", description: "Installed application display name." },
        path: { type: "string", description: "Explicit executable path." },
        launch_path: { type: "string", description: "Exact launch_path returned by computer_list_apps." },
        bundle_id: { type: "string", description: "macOS bundle id or Windows AUMID." },
        aumid: { type: "string", description: "Windows packaged-app AUMID." },
        urls: { type: "array", items: { type: "string" }, description: "URLs to open through the default browser." },
        additional_arguments: { type: "array", items: { type: "string" }, description: "Optional arguments passed to the application." },
        start_minimized: { type: "boolean", description: "Start minimized when supported." },
        target: { type: "string", description: "Human-readable launch purpose for approval." },
      },
      required: [],
    },
  },

  computer_focus_app: {
    name: "computer_focus_app",
    description: "Bring an application window to the foreground when background input is unavailable. Requires human approval because it interrupts the user.",
    parameters: {
      type: "object",
      properties: {
        session_id: { type: "string", description: "Optional existing computer-use session id." },
        pid: { type: "number", description: "Target process id." },
        window_id: { type: "number", description: "Optional target window id." },
        target: { type: "string", description: "Human-readable focus purpose for approval." },
      },
      required: ["pid"],
    },
  },

  computer_click: {
    name: "computer_click",
    description:
      "Click in a local desktop app through the optional Cua driver. " +
      "Provide a visible target label when possible so approval checks can reason about risk.",
    parameters: {
      type: "object",
      properties: {
        session_id: { type: "string", description: "Optional existing computer-use session id. Omit to reuse this chat's active session." },
        pid: { type: "number", description: "Target process id from computer_observe." },
        window_id: { type: "number", description: "Target window id from computer_observe." },
        element_index: { type: "number", description: "Optional element index from get_window_state for the same pid/window_id." },
        element_token: { type: "string", description: "Optional element token from get_window_state." },
        target: { type: "string", description: "Visible target label or element description to click. Use with pid/window_id when possible." },
        x: { type: "number", description: "Optional x coordinate when a target label is unavailable." },
        y: { type: "number", description: "Optional y coordinate when a target label is unavailable." },
        button: { type: "string", enum: ["left", "right", "middle"], description: "Mouse button. Defaults to left." },
        clicks: { type: "number", description: "Use 2 for a double-click. Defaults to 1." },
        dispatch: { type: "string", enum: ["background", "foreground"], description: "Prefer background. Use foreground only after computer_focus_app when the target rejects background input." },
        from_zoom: { type: "boolean", description: "Translate coordinates from the latest computer_zoom result." },
        verify_after: { type: "boolean", description: "Capture bounded accessibility state after the action. Defaults to true." },
        verify_query: { type: "string", description: "Expected visible text after the action. Completion is verified only when this text appears." },
        app_hint: { type: "string", description: "Optional app/window hint for risk classification." },
      },
      required: [],
    },
  },

  computer_type: {
    name: "computer_type",
    description:
      "Type text into a local desktop app through the optional Cua driver. " +
      "Credential, payment, unknown target, or sensitive-app typing requires human approval.",
    parameters: {
      type: "object",
      properties: {
        session_id: { type: "string", description: "Optional existing computer-use session id. Omit to reuse this chat's active session." },
        pid: { type: "number", description: "Target process id from computer_observe." },
        window_id: { type: "number", description: "Target window id from computer_observe." },
        element_index: { type: "number", description: "Optional input element index from get_window_state for the same pid/window_id." },
        element_token: { type: "string", description: "Optional element token from get_window_state." },
        text: { type: "string", description: "Text to type. Never include secrets unless the user explicitly provided and approved them." },
        target: { type: "string", description: "Visible field label or input description." },
        app_hint: { type: "string", description: "Optional app/window hint for risk classification." },
        dispatch: { type: "string", enum: ["background", "foreground"], description: "Input dispatch mode. Prefer background." },
        from_zoom: { type: "boolean", description: "Translate coordinates from the latest zoom capture." },
        verify_after: { type: "boolean", description: "Capture bounded accessibility state after typing. Defaults to true." },
        verify_query: { type: "string", description: "Expected visible text after typing. Do not claim completion unless it matches." },
      },
      required: ["text"],
    },
  },

  computer_set_value: {
    name: "computer_set_value",
    description: "Set a text field, slider, or native select directly through accessibility APIs. Requires a fresh element index/token from computer_observe and follows the same credential/payment approval policy as typing.",
    parameters: {
      type: "object",
      properties: {
        session_id: { type: "string", description: "Optional existing computer-use session id." },
        pid: { type: "number", description: "Target process id." },
        window_id: { type: "number", description: "Target window id when element_index is used." },
        element_index: { type: "number", description: "Element index from the latest targeted computer_observe." },
        element_token: { type: "string", description: "Opaque element token from the latest targeted computer_observe." },
        value: { type: "string", description: "New value for the target control." },
        target: { type: "string", description: "Visible field label for policy and audit." },
        app_hint: { type: "string", description: "Optional application context for policy classification." },
        verify_after: { type: "boolean", description: "Capture bounded accessibility state after setting the value. Defaults to true." },
        verify_query: { type: "string", description: "Expected visible text after setting the value." },
      },
      required: ["pid", "value"],
    },
  },

  computer_hotkey: {
    name: "computer_hotkey",
    description:
      "Press a keyboard shortcut in a local desktop app through the optional Cua driver. " +
      "Submit/delete/modifier shortcuts require human approval.",
    parameters: {
      type: "object",
      properties: {
        session_id: { type: "string", description: "Optional existing computer-use session id. Omit to reuse this chat's active session." },
        pid: { type: "number", description: "Target process id from computer_observe." },
        window_id: { type: "number", description: "Target window id from computer_observe." },
        keys: { type: "array", items: { type: "string" }, description: "Keys to press, e.g. ['Ctrl','L'] or ['Enter']." },
        target: { type: "string", description: "Optional target context for the shortcut." },
        app_hint: { type: "string", description: "Optional app/window hint for risk classification." },
        dispatch: { type: "string", enum: ["background", "foreground"], description: "Input dispatch mode. Prefer background." },
        verify_after: { type: "boolean", description: "Capture bounded accessibility state after the hotkey. Defaults to true." },
        verify_query: { type: "string", description: "Expected visible text after the hotkey." },
      },
      required: ["keys"],
    },
  },

  computer_scroll: {
    name: "computer_scroll",
    description: "Scroll in a local desktop app through the optional Cua driver.",
    parameters: {
      type: "object",
      properties: {
        session_id: { type: "string", description: "Optional existing computer-use session id. Omit to reuse this chat's active session." },
        pid: { type: "number", description: "Target process id from computer_observe." },
        window_id: { type: "number", description: "Target window id from computer_observe." },
        element_index: { type: "number", description: "Optional element index from get_window_state for the same pid/window_id." },
        element_token: { type: "string", description: "Optional element token from get_window_state." },
        direction: { type: "string", enum: ["up", "down", "left", "right"], description: "Scroll direction." },
        amount: { type: "number", description: "Scroll amount. Defaults to 3." },
        by: { type: "string", enum: ["line", "page"], description: "Scroll granularity. Defaults to line." },
        dx: { type: "number", description: "Horizontal scroll delta." },
        dy: { type: "number", description: "Vertical scroll delta." },
        target: { type: "string", description: "Optional scroll target context." },
        app_hint: { type: "string", description: "Optional app/window hint for risk classification." },
        verify_after: { type: "boolean", description: "Capture bounded accessibility state after scrolling. Defaults to true." },
        verify_query: { type: "string", description: "Expected visible text after scrolling when the task has a deterministic target." },
      },
      required: [],
    },
  },

  computer_drag: {
    name: "computer_drag",
    description:
      "Drag in a local desktop app through the optional Cua driver. " +
      "Use a target label when possible; unknown or sensitive targets require approval.",
    parameters: {
      type: "object",
      properties: {
        session_id: { type: "string", description: "Optional existing computer-use session id. Omit to reuse this chat's active session." },
        pid: { type: "number", description: "Target process id from computer_observe." },
        window_id: { type: "number", description: "Target window id from computer_observe." },
        target: { type: "string", description: "Visible target or drag purpose." },
        fromX: { type: "number", description: "Start x coordinate." },
        fromY: { type: "number", description: "Start y coordinate." },
        toX: { type: "number", description: "End x coordinate." },
        toY: { type: "number", description: "End y coordinate." },
        from_x: { type: "number", description: "Start x coordinate in Cua window-local pixels." },
        from_y: { type: "number", description: "Start y coordinate in Cua window-local pixels." },
        to_x: { type: "number", description: "End x coordinate in Cua window-local pixels." },
        to_y: { type: "number", description: "End y coordinate in Cua window-local pixels." },
        app_hint: { type: "string", description: "Optional app/window hint for risk classification." },
        dispatch: { type: "string", enum: ["background", "foreground"], description: "Input dispatch mode. Prefer background." },
        from_zoom: { type: "boolean", description: "Translate coordinates from the latest zoom capture." },
        verify_after: { type: "boolean", description: "Capture bounded accessibility state after dragging. Defaults to true." },
        verify_query: { type: "string", description: "Expected visible text after dragging when the result is text-addressable." },
      },
      required: [],
    },
  },

  computer_zoom: {
    name: "computer_zoom",
    description: "Capture a native-resolution zoom of a bounded window region for reading small text or icons. Read-only and privacy-sensitive.",
    parameters: {
      type: "object",
      properties: {
        session_id: { type: "string", description: "Optional existing computer-use session id." },
        pid: { type: "number", description: "Target process id." },
        window_id: { type: "number", description: "Target window id." },
        x1: { type: "number", description: "Left edge in current screenshot coordinates." },
        y1: { type: "number", description: "Top edge in current screenshot coordinates." },
        x2: { type: "number", description: "Right edge in current screenshot coordinates." },
        y2: { type: "number", description: "Bottom edge in current screenshot coordinates." },
      },
      required: ["pid", "window_id", "x1", "y1", "x2", "y2"],
    },
  },

  computer_wait: {
    name: "computer_wait",
    description: "Wait briefly during a computer-use session.",
    parameters: {
      type: "object",
      properties: {
        session_id: { type: "string", description: "Optional existing computer-use session id. Omit to reuse this chat's active session." },
        ms: { type: "number", description: "Milliseconds to wait. Defaults to 500." },
      },
      required: [],
    },
  },

  computer_stop: {
    name: "computer_stop",
    description: "Stop the active computer-use session for this chat or a supplied session id.",
    parameters: {
      type: "object",
      properties: {
        session_id: { type: "string", description: "Optional existing computer-use session id. Omit to stop this chat's active session." },
      },
      required: [],
    },
  },

};

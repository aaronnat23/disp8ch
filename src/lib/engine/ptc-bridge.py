#!/usr/bin/env python3
"""PTC Bridge — proxies tool_call() from user scripts to the Disp8ch executor via JSON-RPC over stdin/stdout.

This bridge is embedded inline in tools.ts for production execution. This standalone file
serves as documentation and can be used for local testing:

    echo 'result = tool_call("read_file", "{\"path\": \"/etc/hostname\"}")
print(result)' | python3 ptc-bridge.py

The bridge reads a Python script from stdin, executes it with a `tool_call()` function
available in the global namespace, and proxies each call as a JSON-RPC request over stdout.
"""
import sys
import json
import traceback

def tool_call(name, args_json="{}"):
    """Call a Disp8ch tool and return the result. args_json must be a JSON string."""
    request = json.dumps({"type": "tool_call", "name": name, "args": args_json})
    sys.stdout.write(request + "\n")
    sys.stdout.flush()
    response_line = sys.stdin.readline()
    if not response_line:
        return json.dumps({"success": False, "error": "no response from executor"})
    try:
        return json.dumps(json.loads(response_line))
    except Exception:
        return json.dumps({"success": False, "error": f"invalid response: {response_line[:200]}"})

AVAILABLE_TOOLS = {
    "read_file": "Read a file. Args: path (string), lines (int, optional, default all)",
    "write_file": "Write content to a file. Args: path (string), content (string)",
    "list_files": "List directory contents. Args: dir (string)",
}

if __name__ == "__main__":
    user_script = sys.stdin.read()
    namespace = {
        "tool_call": tool_call,
        "AVAILABLE_TOOLS": AVAILABLE_TOOLS,
    }
    try:
        exec(user_script, namespace)
        sys.stdout.flush()
    except Exception as e:
        traceback.print_exc(file=sys.stderr)
        sys.exit(1)

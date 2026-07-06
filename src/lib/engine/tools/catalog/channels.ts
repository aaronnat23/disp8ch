import type { ToolDefinition } from "../types";

export const CHANNEL_TOOL_CATALOG: Record<string, ToolDefinition> = {
  channel_status: {
    name: "channel_status",
    description:
      "Read current runtime readiness for channels, active model providers, voice/STT, image generation, and local video configuration. " +
      "Returns only safe booleans and provider names, never secret values. Use for capability audits before claiming something is configured or callable now.",
    parameters: {
      type: "object",
      properties: {},
      required: [],
    },
  },

  channel_directory: {
    name: "channel_directory",
    description: "List recent known external channel targets so send_message can use a real recipient or a friendly label.",
    parameters: {
      type: "object",
      properties: {
        channel: {
          type: "string",
          description: "Optional channel filter: telegram, discord, whatsapp, slack, bluebubbles, or teams.",
        },
        limit: {
          type: "number",
          description: "Maximum number of targets to return. Defaults to 10, max 50.",
        },
      },
      required: [],
    },
  },

  send_message: {
    name: "send_message",
    description: "Send a message to a connected channel (Telegram, Discord, WhatsApp, WebChat, Slack, BlueBubbles, or Teams). Use channel_directory first if you only know a friendly recipient label.",
    parameters: {
      type: "object",
      properties: {
        channel: {
          type: "string",
          description: "Channel to send to: telegram, discord, whatsapp, webchat, google-chat, slack, bluebubbles, or teams",
          enum: ["telegram", "discord", "whatsapp", "webchat", "google-chat", "slack", "bluebubbles", "teams"],
        },
        recipient: {
          type: "string",
          description: "Chat ID or phone number. Required for Telegram/Discord/WhatsApp. Omit for WebChat.",
        },
        text: {
          type: "string",
          description: "Message text to send",
        },
        blocks_json: {
          type: "string",
          description: "Optional Slack Block Kit JSON array. Only used when channel is slack.",
        },
      },
      required: ["channel", "text"],
    },
  },

};

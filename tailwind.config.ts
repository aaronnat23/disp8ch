import type { Config } from "tailwindcss";

const config: Config = {
  darkMode: "class",
  content: [
    "./src/pages/**/*.{js,ts,jsx,tsx,mdx}",
    "./src/components/**/*.{js,ts,jsx,tsx,mdx}",
    "./src/app/**/*.{js,ts,jsx,tsx,mdx}",
  ],
  theme: {
    extend: {
      fontFamily: {
        mono: ["'JetBrains Mono'", "'Fira Code'", "'Courier New'", "monospace"],
        display: ["'Space Grotesk'", "'Rajdhani'", "system-ui", "sans-serif"],
        sans: ["'JetBrains Mono'", "'Fira Code'", "monospace"],
      },
      colors: {
        border: "hsl(var(--border))",
        input: "hsl(var(--input))",
        ring: "hsl(var(--ring))",
        background: "hsl(var(--background))",
        foreground: "hsl(var(--foreground))",
        primary: {
          DEFAULT: "hsl(var(--primary))",
          foreground: "hsl(var(--primary-foreground))",
        },
        secondary: {
          DEFAULT: "hsl(var(--secondary))",
          foreground: "hsl(var(--secondary-foreground))",
        },
        destructive: {
          DEFAULT: "hsl(var(--destructive))",
          foreground: "hsl(var(--destructive-foreground))",
        },
        muted: {
          DEFAULT: "hsl(var(--muted))",
          foreground: "hsl(var(--muted-foreground))",
        },
        accent: {
          DEFAULT: "hsl(var(--accent))",
          foreground: "hsl(var(--accent-foreground))",
        },
        popover: {
          DEFAULT: "hsl(var(--popover))",
          foreground: "hsl(var(--popover-foreground))",
        },
        card: {
          DEFAULT: "hsl(var(--card))",
          foreground: "hsl(var(--card-foreground))",
        },
        terminal: {
          red: "#ff0000",
          "red-dim": "#cc0000",
          "red-bright": "#ff3333",
        },
        node: {
          trigger: "#ff0000",
          agent: "#ffffff",
          channel: "#ff0000",
          logic: "#888888",
          memory: "#ff0000",
        },
      },
      borderRadius: {
        lg: "0px",
        md: "0px",
        sm: "0px",
      },
      boxShadow: {
        brutalist: "3px 3px 0px #000000",
        "brutalist-sm": "2px 2px 0px #000000",
        "glow-red": "0 0 12px rgba(255, 0, 0, 0.4), 0 0 24px rgba(255, 0, 0, 0.1)",
        "glow-red-sm": "0 0 6px rgba(255, 0, 0, 0.3)",
      },
      animation: {
        "cursor-blink": "cursor-blink 1s step-end infinite",
        "terminal-pulse": "terminal-pulse 2s ease-in-out infinite",
      },
    },
  },
  plugins: [],
};

export default config;

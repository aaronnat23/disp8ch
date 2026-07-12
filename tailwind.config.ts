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
        sans: ["var(--font-sans)", "system-ui", "sans-serif"],
        mono: ["var(--font-mono)", "'JetBrains Mono'", "monospace"],
        display: ["var(--font-display)", "var(--font-sans)", "sans-serif"],
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
          red: "hsl(var(--accent-red) / <alpha-value>)",
          "red-dim": "var(--terminal-red-dim)",
          "red-bright": "hsl(var(--accent-red) / <alpha-value>)",
        },
        node: {
          trigger: "hsl(var(--accent-red))",
          agent: "hsl(var(--foreground))",
          channel: "hsl(var(--accent-red))",
          logic: "hsl(var(--muted-foreground))",
          memory: "hsl(var(--accent-red))",
        },
      },
      borderRadius: {
        lg: "0px",
        md: "0px",
        sm: "0px",
      },
      boxShadow: {
        brutalist: "var(--brutalist-shadow)",
        "brutalist-sm": "var(--brutalist-shadow-sm)",
        "glow-red": "0 0 10px rgba(var(--accent-red-rgb), 0.28), 0 0 20px rgba(var(--accent-red-rgb), 0.08)",
        "glow-red-sm": "0 0 6px rgba(var(--accent-red-rgb), 0.22)",
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

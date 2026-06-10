/** @type {import('tailwindcss').Config} */
export default {
  content: ["./index.html", "./src/**/*.{js,jsx}"],
  theme: {
    extend: {
      colors: {
        ink: { 900: "#0f172a", 700: "#334155", 500: "#64748b", 400: "#94a3b8", 300: "#cbd5e1" },
        brand: { 50: "#eef2ff", 100: "#e0e7ff", 500: "#6366f1", 600: "#4f46e5", 700: "#4338ca" },
        ok: "#16a34a",
        warn: "#d97706",
        err: "#dc2626",
        run: "#2563eb"
      },
      fontFamily: {
        sans: ["-apple-system", "BlinkMacSystemFont", "Segoe UI", "PingFang SC", "sans-serif"]
      }
    }
  },
  plugins: []
};

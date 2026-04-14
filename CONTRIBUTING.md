# Contributing to AG-Code Token

Thank you for considering contributing! Here's how you can help.

## Adding a New Provider

The most impactful contribution is adding support for a new AI coding tool. Here's how:

1. **Create a new file** in `providers/` (e.g., `providers/newtool.js`)
2. **Implement the Provider interface** defined in `providers/types.js`:
   - `name` — unique identifier (lowercase, no spaces)
   - `displayName` — human-readable name
   - `modelDisplayName(model)` — convert raw model IDs to friendly names
   - `toolDisplayName(rawTool)` — convert raw tool names to display names
   - `discoverSessions()` — find session files on disk, return `SessionSource[]`
   - `createSessionParser(source, seenKeys)` — return a parser with an async generator
3. **Register it** in `providers/index.js`
4. **Test it** by running `node server.js` and checking the dashboard

### Provider Guidelines

- Support Windows, macOS, and Linux paths
- Use `try/catch` around all filesystem operations (tools may not be installed)
- Implement deduplication using the `seenKeys` Set
- Normalize tokens to Anthropic semantics (inputTokens = non-cached only)
- Use `calculateCost()` from `models.js` for cost calculation

## Bug Reports

Please include:
- Node.js version (`node --version`)
- Operating system
- Which AI tools you have installed
- Console output when running `node server.js`

## Code Style

- ES Modules (`import`/`export`)
- JSDoc type annotations
- No external dependencies
- Descriptive comments for non-obvious logic

## Pull Requests

1. Fork the repo
2. Create a feature branch (`git checkout -b feature/new-provider`)
3. Commit your changes
4. Push to your fork
5. Open a Pull Request

---

Thanks for helping make AI coding cost tracking better for everyone! 🔥

# Contributing to AG-Code Token

Thank you for your interest in contributing. This guide covers the most common contribution paths.

## Adding a New Provider

The most impactful contribution is adding support for a new AI coding tool. Follow these steps:

1. **Create a new file** in `providers/` (e.g., `providers/newtool.js`)
2. **Implement the Provider interface** defined in `providers/types.js`:
   - `name` — unique identifier (lowercase, no spaces)
   - `displayName` — human-readable name for the dashboard
   - `modelDisplayName(model)` — convert raw model IDs to display names
   - `toolDisplayName(rawTool)` — convert raw tool names to display names
   - `discoverSessions()` — locate session files on disk, return `SessionSource[]`
   - `createSessionParser(source, seenKeys)` — return a parser with an async generator
3. **Register it** in `providers/index.js`
4. **Test** by running `node server.js` and verifying data appears on the dashboard

### Provider Guidelines

- Support Windows, macOS, and Linux path conventions
- Wrap all filesystem operations in `try/catch` (the tool may not be installed)
- Implement deduplication using the `seenKeys` Set parameter
- Normalize token semantics to the Anthropic convention (`inputTokens` = non-cached only)
- Use `calculateCost()` from `models.js` for cost calculation

## Bug Reports

When filing an issue, include:
- Node.js version (`node --version`)
- Operating system and version
- Which AI coding tools are installed
- Console output from `node server.js`

## Code Style

- ES Modules (`import`/`export`)
- JSDoc type annotations for all public functions
- No external dependencies
- Descriptive comments for non-obvious logic
- Error handling around all I/O operations

## Pull Requests

1. Fork the repository
2. Create a feature branch (`git checkout -b feature/new-provider`)
3. Commit your changes with a descriptive message
4. Push to your fork
5. Open a Pull Request with a clear description of what changed and why

## Development

```bash
# Start with auto-reload on file changes
node --watch server.js

# Run the CLI
node cli.js

# Generate a leaderboard profile
node cli.js submit
```

---

Thank you for helping improve AI coding cost visibility for everyone.

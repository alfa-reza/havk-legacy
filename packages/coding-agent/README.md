# Havk

Havk is a minimal, extensible AI agent for the terminal, based on Pi. Adapt Havk to your workflow, not the other way around.

Ask Havk to create the prompt templates, skills, extensions, and themes you need, or install a package. Use Havk directly, automate it in print, JSON, or RPC mode, or build applications with the TypeScript SDK.

## Getting started

Install the command-line interface with npm:

```bash
npm install -g --ignore-scripts @alfa-reza/havk
```

This requires Node.js 22.19 or newer. Havk does not require dependency lifecycle scripts for a normal npm installation.

Start Havk in the directory where you want it to work:

```bash
cd /path/to/project
havk
```

For a built-in AI provider, run `/login` inside Havk to connect a subscription or API key. Then give Havk a task.

See the [documentation](docs/index.md) for full setup and usage instructions. Upstream Pi documentation and website are available at [pi.dev](https://pi.dev).

## Development

Clone the repository, install its dependencies, and run from source:

```bash
git clone https://github.com/alfa-reza/havk
cd havk
npm install --ignore-scripts
./pi-test.sh
```

`pi-test.sh` can be called from any directory and preserves the caller's working directory.

Before submitting changes, run:

```bash
npm run check
./test.sh
```

Read [CONTRIBUTING.md](../../CONTRIBUTING.md) before opening an issue or pull request. Read [AGENTS.md](../../AGENTS.md) for repository-specific implementation, testing, dependency, and release rules.

## License

MIT

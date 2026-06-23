# Security Policy

## Reporting

Please report security issues privately instead of opening a public issue with exploit details or secrets.

Do not paste API keys, tokens, private memory, database files, or channel credentials into GitHub issues.

Use GitHub's private vulnerability reporting for this repository when available. Otherwise, contact the maintainer
privately through the address listed on the maintainer's GitHub profile. Include the affected version, reproduction
steps, impact, and any suggested mitigation. Please allow reasonable time for investigation before public disclosure.

## Supported Versions

Security fixes are applied to the latest published release and the current `main` branch.

## Local Data Warning

disp8ch is local-first and stores runtime state on disk. Depending on your configuration, local data may include:

- chat/session history
- memory and skill files
- workflow definitions
- channel configuration
- document metadata
- local database files

Do not publish your `data/` directory or screenshots containing private content.

## Supported Security Boundaries

The app includes confirmation gates and approval paths for risky actions, but you still control deployment and network exposure. Be careful with:

- exposed ports
- webhook URLs and signing secrets
- channel bot tokens
- workflow nodes that send messages, call paid APIs, write files, or execute shell commands
- MCP servers and custom tools from untrusted sources

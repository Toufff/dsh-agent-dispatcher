# Development instructions

Read docs/architecture.md before changing dispatch behavior. Keep fallback limited to confirmed pre-execution rejection. Test ambiguity, restart and reporting failures, not only successful launches.

Do not commit real credentials, user-specific paths, issue payloads or transcripts. CLI adapters must use official executables and existing authentication without reading login secrets. Keep Claude live-test status explicit.

Run npm test and npm run check before pushing changes. Document incomplete integrations honestly. No runtime configuration should point at a real project by default.

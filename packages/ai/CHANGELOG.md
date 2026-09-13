# Changelog

All notable changes to this project will be documented in this file.

## [Unreleased]

### Added

### Fixed

- Fixed Amazon Bedrock one-hour cache writes being priced at the five-minute rate ([#9457](https://github.com/earendil-works/pi/issues/9457)).
- Added `RetryPolicy.maxAgentDelayMs` support to cap shared assistant retry backoff for summarization calls ([#8826](https://github.com/earendil-works/pi/issues/8826)).
- Fixed quadratic CPU usage when draining buffered `EventStream` events ([#9055](https://github.com/earendil-works/pi/issues/9055)).
- Fixed Mistral Medium reasoning requests to use `reasoning_effort` for all reasoning-capable `mistral-medium-*` model IDs instead of the unsupported `prompt_mode` ([#8700](https://github.com/earendil-works/pi/issues/8700)).
- Removed `models.json` and `data/` output from git tracking to prevent merge conflicts when updating generated models.
- Updated npm-shrinkwrap.json to lock transitive dependencies.
- Added model parameter mapping tests for OpenCode Go and OpenCode models.
- Added support for new `xiaomi-token-plan` models.
- Updated default max tokens for reasoning-capable models to 32k.
- Fixed stream parser error handling when receiving incomplete chunks.

### Changed

### Removed

## [0.85.1] - 2026-04-12

# Changelog

## [1.1.0](https://github.com/sebastienlevert/copilot-eval/compare/copilot-eval-v1.0.0...copilot-eval-v1.1.0) (2026-05-05)


### Features

* add --file flag to run evals from a specific file ([b0ab149](https://github.com/sebastienlevert/copilot-eval/commit/b0ab1492588488c1e79c0221cfa4fc1ec4f15e45))
* add .git sentinel file in workspace dirs to prevent git root traversal ([b4a4231](https://github.com/sebastienlevert/copilot-eval/commit/b4a42316af299746750ae49db3b27962fa08258e))
* graceful interrupts, incremental saves, transient error retry, judge model, remove --skill ([256749a](https://github.com/sebastienlevert/copilot-eval/commit/256749ac969933a9380c2c8cccf372d7b819a7ab))
* implement automated NPM publish pipeline ([#3](https://github.com/sebastienlevert/copilot-eval/issues/3)) ([3cb8c09](https://github.com/sebastienlevert/copilot-eval/commit/3cb8c09ed00df721cf265b11ce4aa334e710bbb1))
* switch to YAML evals, rename expected to expected_response, recursive skill discovery, add docs ([093c7bf](https://github.com/sebastienlevert/copilot-eval/commit/093c7bf46c10871d92686349481c2d4b86ea1c0a))


### Bug Fixes

* full Windows compatibility for spawn and plugin loading ([5c80238](https://github.com/sebastienlevert/copilot-eval/commit/5c8023845420dfeeaed425ecad833ff4b8c2c073))
* use PAT for release-please to trigger CI on PRs ([#4](https://github.com/sebastienlevert/copilot-eval/issues/4)) ([2d061f8](https://github.com/sebastienlevert/copilot-eval/commit/2d061f86bbf76b27283403db0b33e9a990f17c46))
* Windows compatibility for spawn and script execution ([801305e](https://github.com/sebastienlevert/copilot-eval/commit/801305e5d51d6e077607f0a8f56961f1459a121a))

# Contributing to BeamSketch

Thanks for helping! Bug reports, laser models for `devices/devices.json`, translations and code are all
welcome.

## Before you start

- For bigger changes, please open an issue first so we can agree on the approach.
- The editor has no build step and no dependencies – please keep it that way.
- Match the style of the surrounding code (comments are in German, that's fine to keep).
- Wrap new user-facing text in `loc('…')` and add it to every file in `js/locales/` (an English
  translation is enough to start; missing entries fall back to German).
- Test your change in Chrome and Firefox with `node serve.js`. If it touches GCode or the USB
  connection, describe how you tested it with a real laser.

## License of contributions

BeamSketch is published under the GNU AGPL v3. The hosted service at beamsketch.com combines this
editor with additional parts that are not open source (accounts, online storage, AI tools).

By submitting a contribution (pull request, patch or similar) you confirm that

1. you wrote it yourself or have the right to submit it, and
2. you license it under the GNU AGPL v3 **and** grant Felix Stopa a perpetual, worldwide, non-exclusive,
   royalty-free license to use, modify and distribute it under other license terms as well, including in
   the service at beamsketch.com.

This keeps the editor open for everyone while allowing the hosted service to continue. If you don't
agree with this, please don't submit the contribution.

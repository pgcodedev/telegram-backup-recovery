# Contributing

Thanks for considering a contribution! This is a small, focused tool, so the
bar for changes is simple:

1. **Fork** the repo and create a branch off `main`.
2. Keep changes scoped - one feature/fix per pull request is easiest to review.
3. Test locally (`python app.py`, walk through login → channel select → download)
   before opening a PR. There's no CI test suite yet - a good first contribution
   would be adding one.
4. Describe **what** changed and **why** in the PR description. Screenshots or
   a short screen recording are appreciated for UI changes.

## Ideas for contributions

- [ ] Resume support: skip messages already downloaded on a previous run
- [ ] Export to a single `.zip` at the end of a backup
- [ ] Dark/light theme toggle
- [ ] Docker image / `docker-compose.yml`
- [ ] Automated tests for the Flask routes
- [ ] i18n / non-English UI strings

## Reporting bugs

Open an issue with: your OS, Python version, the exact steps to reproduce,
and any relevant log output from the console the app is running in (redact
your `api_hash`, phone number, and session file contents first).

## Code style

Plain, readable Python (PEP 8-ish) and vanilla JS/CSS - no build step, no
frameworks beyond Flask and Telethon, on purpose. Please keep it that way
unless discussed in an issue first.

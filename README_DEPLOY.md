# Joybuy FR Agent MVP Deployment

This app is a single Python web service:

- Static frontend is served from `web/`
- API backend is served from `server.py`
- Simulated product catalog is stored in `data/joybuy_catalog.json`

## Render

Use `render.yaml` as a Blueprint, or create a Web Service manually:

- Runtime: Python
- Build command: `pip install -r requirements.txt`
- Start command: `python server.py`

## Required Port

For local use the app listens on `127.0.0.1:8765`.
For hosted deployment, update `server.py` to read the provider `PORT` environment variable if the platform requires it.

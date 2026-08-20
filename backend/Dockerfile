# Self-contained backend image — build context is this directory.
FROM python:3.11-slim

RUN apt-get update && apt-get install -y --no-install-recommends libpq-dev gcc \
    && rm -rf /var/lib/apt/lists/*

RUN useradd --create-home app
WORKDIR /app

COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY . .
RUN chown -R app:app /app
USER app

# Cloud Run injects $PORT; default 8000 for compose/local.
ENV PORT=8000
EXPOSE 8000

# Migrations run as a separate release step, not here, so autoscaled instances
# don't race on startup. exec keeps uvicorn as PID 1 for clean SIGTERM.
CMD ["sh", "-c", "exec uvicorn main:app --host 0.0.0.0 --port ${PORT}"]

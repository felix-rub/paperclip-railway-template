FROM node:24.11.0-slim

# Install gosu (privilege dropping in entrypoint) and ca-certificates.
# ca-certificates is required: node:24.11.0-slim ships without the system CA bundle, and the
# agent CLIs (codex/claude) use the OS trust store for TLS to api.openai.com / api.anthropic.com.
# Without it, agent runs fail with "no native root CA certificates found". (Node's own fetch is
# unaffected because Node bundles its own CAs.)
RUN apt-get update && apt-get install -y --no-install-recommends gosu ca-certificates && rm -rf /var/lib/apt/lists/*

# Create a non-root user (required: Claude CLI refuses --dangerously-skip-permissions as root)
RUN groupadd -r paperclip && useradd -r -g paperclip -m -d /home/paperclip -s /bin/bash paperclip

# Create the paperclip home directory (Railway volume mount point)
RUN mkdir -p /paperclip && chown -R paperclip:paperclip /paperclip

WORKDIR /app

# Changing this pin intentionally invalidates Railway's dependency layer so the
# image cannot retain an earlier Paperclip UI bundle.
ARG PAPERCLIP_VERSION=2026.831.1

# Copy package files and install dependencies
COPY package.json ./
RUN npm install --omit=dev \
    && test "$(node -p "require('./node_modules/paperclipai/package.json').version")" = "$PAPERCLIP_VERSION"

# Copy application code
COPY . .

# Give ownership of everything to the non-root user
RUN chown -R paperclip:paperclip /app /home/paperclip

# Copy and set up entrypoint (fixes volume mount ownership at runtime)
COPY entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh

# Railway injects PORT at runtime (default 3100). Gemini ACP must not start
# its own nested sandbox, which does not inherit the Railway API-key environment.
ENV PORT=3100 \
    GEMINI_SANDBOX=false
EXPOSE 3100

# Entrypoint runs as root to fix volume permissions, then drops to paperclip user
ENTRYPOINT ["/entrypoint.sh"]
CMD ["npm", "start"]

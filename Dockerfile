FROM node:24-slim

# Install gosu (privilege dropping in entrypoint) and ca-certificates.
# ca-certificates is required: node:24-slim ships without the system CA bundle, and the
# agent CLIs (codex/claude) use the OS trust store for TLS to api.openai.com / api.anthropic.com.
# Without it, agent runs fail with "no native root CA certificates found". (Node's own fetch is
# unaffected because Node bundles its own CAs.)
RUN apt-get update && apt-get install -y --no-install-recommends gosu ca-certificates git curl && rm -rf /var/lib/apt/lists/*

# Create a non-root user (required: Claude CLI refuses --dangerously-skip-permissions as root)
RUN groupadd -r paperclip && useradd -r -g paperclip -m -d /home/paperclip -s /bin/bash paperclip

# Create the paperclip home directory (Railway volume mount point)
RUN mkdir -p /paperclip && chown -R paperclip:paperclip /paperclip

WORKDIR /app

# Copy package files and install dependencies
COPY package.json ./
COPY scripts/patch-bundled-zod.mjs ./scripts/
COPY scripts/build-openrouter-adapter.mjs ./scripts/
COPY adapters ./adapters
RUN npm install --omit=dev && node scripts/patch-bundled-zod.mjs && npm run build && ln -sf /app/node_modules/.bin/pi /usr/local/bin/pi

# Copy application code
COPY . .

# Give ownership of everything to the non-root user
RUN chown -R paperclip:paperclip /app /home/paperclip

# Copy and set up entrypoint (fixes volume mount ownership at runtime; strip CRLF from Windows uploads)
COPY entrypoint.sh /entrypoint.sh
RUN sed -i 's/\r$//' /entrypoint.sh && chmod +x /entrypoint.sh

# Railway injects PORT at runtime (default 3100). GEMINI_SANDBOX=false stops the
# Gemini CLI engine from launching its own Docker-in-Docker sandbox inside this
# container. (The ACP engine is unaffected: Paperclip spawns it with an env
# allowlist that does not include GEMINI_SANDBOX.)
ENV PORT=3100 \
    GEMINI_SANDBOX=false
EXPOSE 3100

# Entrypoint runs as root to fix volume permissions, then drops to paperclip user
ENTRYPOINT ["/entrypoint.sh"]
CMD ["npm", "start"]

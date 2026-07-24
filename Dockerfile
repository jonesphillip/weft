FROM docker.io/cloudflare/sandbox:0.6.7

# Install Claude Code CLI
RUN npm install -g @anthropic-ai/claude-code

# Longer timeout for Claude Code operations
ENV COMMAND_TIMEOUT_MS=300000

# Run as non-root user
USER node

# Port 3000 is used by the sandbox SDK internally
EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD curl -f http://localhost:3000/health || exit 1

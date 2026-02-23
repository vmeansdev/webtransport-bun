FROM rust:1.85-bookworm

ARG BUN_VERSION=1.3.9
ENV BUN_INSTALL=/root/.bun
ENV PATH=/root/.bun/bin:/root/.cargo/bin:${PATH}

RUN apt-get update \
  && apt-get install -y --no-install-recommends curl ca-certificates openssl build-essential pkg-config libssl-dev \
  && rm -rf /var/lib/apt/lists/*

RUN curl -fsSL https://bun.sh/install | bash -s -- bun-v${BUN_VERSION}

WORKDIR /app
COPY . .

RUN bun install --frozen-lockfile
RUN bun run build:native
RUN bun run example:echo:cert

EXPOSE 3000/tcp
EXPOSE 4433/udp

ENV HTTP_HOST=0.0.0.0
ENV HTTP_PORT=3000
ENV WT_PORT=4433

CMD ["bun", "run", "example:echo"]

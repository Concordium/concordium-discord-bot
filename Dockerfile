# Use official Node.js image
ARG build_image="node:20"
FROM ${build_image}

# Install system dependencies (curl + CA certs for TLS) and clean apt cache
RUN apt-get update && \
    apt-get install -y --no-install-recommends ca-certificates curl && \
    rm -rf /var/lib/apt/lists/*

# Install concordium-client CLI (needs CA certs for HTTPS)
RUN curl -L https://github.com/Concordium/concordium-client/releases/download/9.1.4-0-rc/concordium-client-linux \
    -o /usr/bin/concordium-client && \
    chmod +x /usr/bin/concordium-client

# Create and set app directory
WORKDIR /app

# Copy package and install dependencies
COPY package*.json ./
RUN npm install

# Copy all source files, including roles/ and utils/
COPY . .

# Start both bot.js and server.js via concurrently
CMD ["npm", "start"]
# Use official Node.js image
FROM node:20

# Install system dependencies
RUN apt-get update && apt-get install -y curl

# Install concordium-client CLI
RUN curl -L https://distribution.concordium.software/tools/linux/concordium-client_8.0.0-5 \
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
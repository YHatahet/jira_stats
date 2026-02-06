# Use lightweight Node image
FROM node:18-alpine

# Set working directory
WORKDIR /app

# Copy package files first (better caching)
COPY package.json ./

# Install dependencies
RUN npm install --production

# Copy source code
COPY server.js .

# Expose port
EXPOSE 3000

# Start application
CMD ["node", "server.js"]
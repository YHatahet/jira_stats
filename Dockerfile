# Use official Node.js LTS (Long Term Support) alpine image for small footprint
FROM node:20-alpine

# Set the working directory inside the container
WORKDIR /usr/src/app

# Copy package files first to leverage Docker cache for dependencies
COPY package*.json ./

# Install dependencies (only production to keep image small)
RUN npm install --omit=dev

# Copy the rest of the application code
COPY . .

# Expose the port the app runs on
EXPOSE 3000

# Define the command to run the app
CMD ["node", "server.js"]
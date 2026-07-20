# Use the official Node 20 Alpine image as our base image
# Alpine is lightweight and secure, making it ideal for containers
FROM node:20-alpine

# Create a non-root user and group for better security
# Running as root inside the container is an anti-pattern
RUN addgroup -S appgroup && adduser -S appuser -G appgroup

# Set the working directory for all subsequent commands
# This keeps our files organized in a specific location
WORKDIR /usr/src/app

# Copy package.json and package-lock.json if available
# We do this before copying the source code to cache npm install
COPY package*.json ./

# Install production dependencies only using npm ci
# --omit=dev prevents installing Jest and other dev tools
RUN npm ci --omit=dev

# Copy the src directory into the container
# This brings in our actual application code
COPY src/ ./src/

# Copy the public directory for the PWA
# This contains our frontend assets
COPY src/public/ ./src/public/

# Expose port 8080, which is the default for Cloud Run
# This is documentation, Cloud Run handles actual routing
EXPOSE 8080

# Set default environment variables
# These can be overridden by Cloud Run at runtime
ENV PORT=8080
ENV NODE_ENV=production

# Switch to the non-root user we created earlier
# This drops privileges before running the Node process
USER appuser

# Define the command to start our Express server
# This starts Node directly without an npm wrapper for better signal handling
CMD ["node", "src/index.js"]

# Use the Bun image as the base image
FROM oven/bun:latest

# Set the working directory in the container
WORKDIR /app

# Copy the current directory contents into the container at /app
COPY . .

# Install dependencies
RUN bun install --frozen-lockfile

# OAuth callback server (see src/oauth.ts)
EXPOSE 3000

# Run the server when the container launches
ENTRYPOINT ["bun", "start"]
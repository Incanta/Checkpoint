FROM debian:bookworm

# Install dependencies
RUN apt-get update
RUN apt-get install -y --reinstall ca-certificates
RUN apt-get install -y --no-install-recommends \
    build-essential \
    cmake \
    clang \
    libssl-dev \
    libpsl-dev \
    git

WORKDIR /app

CMD ["bash", "-c", "./build-cpp.sh"]

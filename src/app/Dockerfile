FROM node:20

RUN corepack enable
COPY . /app
WORKDIR /app
RUN yarn

CMD ["yarn", "start"]

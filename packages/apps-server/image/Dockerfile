# The wicked-apps-server image (DES-APPS-001 §8.1, §9.3 step 4). Product-owned and pinned: an Apps publish
# builds THIS file over a context crew wrote itself (the server, the runtime, and the app's checked files
# read from its git objects). Nothing from the app repository is executed, and nothing is pushed anywhere:
# the deployer runs the image.
#
# Run it with the environment names the manifest lists (a missing one stops the server, naming it) and, for
# an app with actions, a volume at /data (its action records, audit and decision logs):
#   docker run -p 8080:8080 -e APPS_SRC_SUPPORT_PG_PASSWORD=… -v escalations-data:/data <image>
# One server per volume: a second container on the same volume stops, naming the first. A graceful stop
# (docker stop / restart) releases the volume at once; after a crash or `docker rm -f` it is free again once the
# old claim has not been seen for 30 s (a restart policy retries until then).
FROM node:24-bookworm-slim@sha256:c86ecead9e55a5210ac1727de38a4ca840bf03dcaf34dc9749addbf383b1920c

ENV NODE_ENV=production
# The SQLite reader resolves its runner three directories above the bundle (crew's drivers/sqlite.ts).
COPY server/ /srv/server/
COPY runners/ /srv/runners/
COPY site/ /srv/site/
# /data is where a mounted volume goes (owned by node, so a fresh named volume is writable). There is no VOLUME
# instruction on purpose: it would mount an anonymous volume when the deployer gave none, and actions would run on
# a store that disappears with the container. Without an explicit -v, the server refuses every action and says so.
RUN mkdir -p /data && chown node:node /data
USER node
EXPOSE 8080
ENTRYPOINT ["node", "--disable-warning=ExperimentalWarning", "/srv/server/lib/bundle/server.mjs"]

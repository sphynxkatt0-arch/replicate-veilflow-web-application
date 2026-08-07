FROM node:22.17.0-alpine
WORKDIR /app
COPY services/collector ./services/collector
RUN addgroup -S veilflow && adduser -S veilflow -G veilflow && mkdir -p /data && chown -R veilflow:veilflow /app /data
USER veilflow
ENV NODE_ENV=production VEILFLOW_DATA_DIR=/data
VOLUME ["/data"]
HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||8787)+'/health').then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))"
CMD ["node", "services/collector/api.mjs"]

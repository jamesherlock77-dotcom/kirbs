import asyncio
import json
import os
from typing import Optional

import aiohttp


ACCESS_TOKEN = os.environ.get("OCULUS_ACCESS_TOKEN", "OC|752908224809889|")
APP_ID = int(os.environ.get("OCULUS_APP_ID", "7190422614401072"))
DOCID = int(os.environ.get("OCULUS_DOC_ID", "6771539532935162"))


class GraphQLClient:
    def __init__(
        self,
        url: str = "https://graph.oculus.com/graphql",
        max_requests: int = 5,
        per_seconds: float = 5.0,
    ) -> None:
        self.url = url
        self.max_requests = max_requests
        self.per_seconds = per_seconds
        self._timestamps: list[float] = []
        self._session: Optional[aiohttp.ClientSession] = None
        self._timeout = aiohttp.ClientTimeout(total=15)
        self._lock = asyncio.Lock()

    async def _acquire_slot(self) -> None:
        async with self._lock:
            loop = asyncio.get_running_loop()
            now = loop.time()
            self._timestamps = [t for t in self._timestamps if now - t < self.per_seconds]

            if len(self._timestamps) >= self.max_requests:
                delay = self.per_seconds - (now - self._timestamps[0])
                if delay > 0:
                    await asyncio.sleep(delay)

            self._timestamps.append(asyncio.get_running_loop().time())

    def _get_session(self) -> aiohttp.ClientSession:
        if self._session is None or self._session.closed:
            self._session = aiohttp.ClientSession(timeout=self._timeout)
        return self._session

    async def post(self, payload: dict) -> Optional[dict]:
        await self._acquire_slot()
        session = self._get_session()

        try:
            async with session.post(self.url, data=payload) as resp:
                resp.raise_for_status()
                return await resp.json(content_type=None)
        except aiohttp.ClientConnectionError as e:
            print(f"GraphQL connection error: {type(e).__name__}: {e}")
            await self.close()
            return None
        except aiohttp.ClientResponseError as e:
            print(f"GraphQL response error: {e.status} {e.message}")
            return None
        except Exception as e:
            print(f"GraphQL error: {type(e).__name__}: {e}")
            return None

    async def close(self) -> None:
        if self._session and not self._session.closed:
            await self._session.close()
        self._session = None

    async def __aenter__(self) -> "GraphQLClient":
        return self

    async def __aexit__(self, *_) -> None:
        await self.close()


# Module-level client — no dependency on an external `bot` object
_client = GraphQLClient()


def _payload() -> dict:
    return {
        "access_token": ACCESS_TOKEN,
        "variables": json.dumps({"applicationID": str(APP_ID)}),
        "doc_id": str(DOCID),
    }


async def fetch_store_metadata() -> Optional[dict]:
    data = await _client.post(_payload())
    return data if isinstance(data, dict) else None


async def get_live_version(meta: Optional[dict] = None) -> Optional[str]:
    if meta is None:
        meta = await fetch_store_metadata()

    if not isinstance(meta, dict):
        return None

    nodes = (
        meta.get("data", {})
        .get("node", {})
        .get("liveChannel", {})
        .get("nodes", [])
    )
    if not nodes:
        return None

    return nodes[0].get("latest_supported_binary", {}).get("version")


async def get_dev_version(meta: Optional[dict] = None) -> Optional[str]:
    if meta is None:
        meta = await fetch_store_metadata()

    if not isinstance(meta, dict):
        return None

    nodes = (
        meta.get("data", {})
        .get("node", {})
        .get("primary_binaries", {})
        .get("nodes", [])
    )
    if not nodes:
        return None

    return nodes[0].get("version")


async def run() -> None:
    async with _client:
        meta = await fetch_store_metadata()
        live = await get_live_version(meta)
        dev = await get_dev_version(meta)
        print(f"Live: {live}\nDev:  {dev}")


if __name__ == "__main__":
    asyncio.run(run())

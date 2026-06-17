import asyncio
import json
import os
from typing import Optional


import aiohttp
import discord
from discord.ext import commands, tasks


# ── Config ────────────────────────────────────────────────────────────────────
ACCESS_TOKEN = "OC|752908224809889|"
APP_ID       = 7190422614401072
DOCID        = 6771539532935162
CHANNEL_ID   = 1503559649259950190
ROLE_MENTION = "<@&1511530779576893561>"  # pinged on live updates only


# ── GraphQL client ────────────────────────────────────────────────────────────
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
        try:
            async with self._get_session().post(self.url, data=payload) as resp:
                resp.raise_for_status()
                return await resp.json(content_type=None)
        except aiohttp.ClientConnectionError as e:
            print(f"[GraphQL] Connection error: {e}")
            await self.close()
        except aiohttp.ClientResponseError as e:
            print(f"[GraphQL] Response error: {e.status} {e.message}")
        except Exception as e:
            print(f"[GraphQL] Unexpected error: {type(e).__name__}: {e}")
        return None

    async def close(self) -> None:
        if self._session and not self._session.closed:
            await self._session.close()
        self._session = None


# ── Oculus helpers ────────────────────────────────────────────────────────────
def _payload() -> dict:
    return {
        "access_token": ACCESS_TOKEN,
        "variables": json.dumps({"applicationID": str(APP_ID)}),
        "doc_id": str(DOCID),
    }


async def fetch_store_metadata(client: GraphQLClient) -> Optional[dict]:
    data = await client.post(_payload())
    return data if isinstance(data, dict) else None


def get_live_version(meta: dict) -> Optional[str]:
    nodes = (
        meta.get("data", {})
        .get("node", {})
        .get("liveChannel", {})
        .get("nodes", [])
    )
    return nodes[0].get("latest_supported_binary", {}).get("version") if nodes else None


def get_dev_version(meta: dict) -> Optional[str]:
    nodes = (
        meta.get("data", {})
        .get("node", {})
        .get("primary_binaries", {})
        .get("nodes", [])
    )
    return nodes[0].get("version") if nodes else None


# ── Bot ───────────────────────────────────────────────────────────────────────
class VersionBot(commands.Bot):
    def __init__(self) -> None:
        intents = discord.Intents.default()
        super().__init__(command_prefix="!", intents=intents)
        self.graphql_client = GraphQLClient()
        self._last_live: Optional[str] = None
        self._last_dev: Optional[str] = None

    async def setup_hook(self) -> None:
        self.version_poller.start()

    async def close(self) -> None:
        self.version_poller.cancel()
        await self.graphql_client.close()
        await super().close()

    async def on_ready(self) -> None:
        print(f"[Bot] Logged in as {self.user} (id: {self.user.id})")

    @tasks.loop(minutes=5)
    async def version_poller(self) -> None:
        meta = await fetch_store_metadata(self.graphql_client)
        if meta is None:
            print("[Poller] Failed to fetch metadata, skipping.")
            return

        live = get_live_version(meta)
        dev  = get_dev_version(meta)

        # First run — seed state silently, no notifications
        if self._last_live is None and self._last_dev is None:
            self._last_live = live
            self._last_dev  = dev
            print(f"[Poller] Initial state seeded — Live: {live} | Dev: {dev}")
            return

        print(f"[Poller] Checked — Live: {live} | Dev: {dev}")

        channel = self.get_channel(CHANNEL_ID)
        if channel is None:
            print(f"[Poller] Channel {CHANNEL_ID} not found.")
            return

        # Live update — ping the role
        if live != self._last_live:
            embed = discord.Embed(
                title="🟢 Live Version Updated",
                color=discord.Color.green(),
            )
            embed.add_field(name="Previous", value=self._last_live or "unknown", inline=True)
            embed.add_field(name="New",      value=live or "unknown",            inline=True)
            await channel.send(content=ROLE_MENTION, embed=embed)
            self._last_live = live

        # Dev update — no ping
        if dev != self._last_dev:
            embed = discord.Embed(
                title="🔧 Dev Version Updated",
                color=discord.Color.orange(),
            )
            embed.add_field(name="Previous", value=self._last_dev or "unknown", inline=True)
            embed.add_field(name="New",      value=dev or "unknown",            inline=True)
            await channel.send(embed=embed)
            self._last_dev = dev

    @version_poller.before_loop
    async def before_poller(self) -> None:
        await self.wait_until_ready()


# ── Entry point ───────────────────────────────────────────────────────────────
if __name__ == "__main__":
    bot = VersionBot()
    bot.run(os.environ["DISCORD_TOKEN"])

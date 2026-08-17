import datetime

import discord
from discord.ext import commands

from config import GUILD_ID, JOIN_LEAVE_WEBHOOK_URL
from utils.log_containers import send_log

WEBHOOK_NAME = "Joins & Leaves"


class JoinLeave(commands.Cog):
    def __init__(self, bot: commands.Bot):
        self.bot = bot
        self.webhook: discord.Webhook | None = None
        # guild_id -> {invite_code: uses}
        self.invite_cache: dict[int, dict[str, int]] = {}
        self.vanity_cache: dict[int, int] = {}

    async def cog_load(self):
        if JOIN_LEAVE_WEBHOOK_URL:
            self.webhook = discord.Webhook.from_url(
                JOIN_LEAVE_WEBHOOK_URL, session=self.bot.session
            )
        else:
            print("[join_leave] JOIN_LEAVE_WEBHOOK_URL not set, join/leave logging disabled.")

    def _in_scope(self, guild: discord.Guild | None) -> bool:
        return guild is not None and guild.id == GUILD_ID

    async def log(self, **kwargs):
        await send_log(self.webhook, username=WEBHOOK_NAME, **kwargs)

    async def _cache_invites(self, guild: discord.Guild):
        try:
            invites = await guild.invites()
            self.invite_cache[guild.id] = {inv.code: inv.uses or 0 for inv in invites}
        except discord.Forbidden:
            print(f"[join_leave] missing Manage Server perms in {guild.id}, can't track invites.")
            self.invite_cache[guild.id] = {}

        if "COMMUNITY" in guild.features or guild.vanity_url_code:
            try:
                vanity = await guild.vanity_invite()
                self.vanity_cache[guild.id] = vanity.uses or 0
            except (discord.Forbidden, discord.HTTPException):
                pass

    @commands.Cog.listener()
    async def on_ready(self):
        for guild in self.bot.guilds:
            if guild.id == GUILD_ID:
                await self._cache_invites(guild)

    @commands.Cog.listener()
    async def on_invite_create(self, invite: discord.Invite):
        if not self._in_scope(invite.guild):
            return
        self.invite_cache.setdefault(invite.guild.id, {})[invite.code] = invite.uses or 0

    @commands.Cog.listener()
    async def on_invite_delete(self, invite: discord.Invite):
        if not self._in_scope(invite.guild):
            return
        self.invite_cache.get(invite.guild.id, {}).pop(invite.code, None)

    async def _find_used_invite(self, guild: discord.Guild) -> str:
        """Diff current invite uses against cache to guess which invite was used.
        Returns a human-readable description."""
        before = self.invite_cache.get(guild.id, {})

        try:
            current = await guild.invites()
        except discord.Forbidden:
            return "Unknown (missing Manage Server permission)"

        current_map = {inv.code: inv for inv in current}

        used_invite = None
        for inv in current:
            prior_uses = before.get(inv.code, 0)
            if (inv.uses or 0) > prior_uses:
                used_invite = inv
                break

        # An invite with max_uses=1 disappears entirely once used up.
        if used_invite is None:
            for code in before:
                if code not in current_map:
                    used_invite = code  # only the code survives
                    break

        # refresh cache regardless of outcome
        self.invite_cache[guild.id] = {inv.code: inv.uses or 0 for inv in current}

        # vanity URL check
        if guild.vanity_url_code:
            try:
                vanity = await guild.vanity_invite()
                prior_vanity = self.vanity_cache.get(guild.id, 0)
                if (vanity.uses or 0) > prior_vanity:
                    self.vanity_cache[guild.id] = vanity.uses or 0
                    return f"Vanity URL `discord.gg/{guild.vanity_url_code}`"
            except (discord.Forbidden, discord.HTTPException):
                pass

        if isinstance(used_invite, discord.Invite):
            inviter = used_invite.inviter
            inviter_str = f"{inviter.mention} (`{inviter}`)" if inviter else "Unknown"
            return f"`{used_invite.code}` created by {inviter_str} — {used_invite.uses} uses"
        elif isinstance(used_invite, str):
            return f"`{used_invite}` (single-use invite, now expired — inviter unknown)"
        else:
            return "Unknown (possibly used a one-time link that already expired, or joined via Discovery)"

    @commands.Cog.listener()
    async def on_member_join(self, member: discord.Member):
        if not self._in_scope(member.guild):
            return

        invite_info = await self._find_used_invite(member.guild)
        account_age = discord.utils.utcnow() - member.created_at
        age_flag = " ⚠️ **new account**" if account_age < datetime.timedelta(days=7) else ""

        await self.log(
            title="📥 Member Joined",
            lines=[
                f"**User:** {member.mention} (`{member}` / `{member.id}`)",
                f"**Account created:** {discord.utils.format_dt(member.created_at, style='R')}{age_flag}",
                f"**Invite used:** {invite_info}",
                f"**Member count:** {member.guild.member_count}",
            ],
            accent_color=discord.Color.green(),
            thumbnail_url=member.display_avatar.url,
        )

    @commands.Cog.listener()
    async def on_member_remove(self, member: discord.Member):
        if not self._in_scope(member.guild):
            return

        joined = member.joined_at
        stayed = ""
        if joined:
            delta = discord.utils.utcnow() - joined
            stayed = f" (in server for {delta.days} days)"

        roles = [r.mention for r in member.roles if r.name != "@everyone"]
        roles_str = ", ".join(roles) if roles else "None"

        await self.log(
            title="📤 Member Left",
            lines=[
                f"**User:** {member.mention} (`{member}` / `{member.id}`)",
                f"**Joined:** "
                + (discord.utils.format_dt(joined, style="R") if joined else "Unknown")
                + stayed,
                f"**Roles had:** {roles_str}",
                f"**Member count:** {member.guild.member_count}",
            ],
            accent_color=discord.Color.red(),
            thumbnail_url=member.display_avatar.url,
        )


async def setup(bot: commands.Bot):
    await bot.add_cog(JoinLeave(bot))

import discord
from discord.ext import commands

from config import GUILD_ID, MOD_LOG_WEBHOOK_URL
from utils.log_containers import send_log

WEBHOOK_NAME = "Mod Log"


def _fmt_user(user: discord.abc.User | None) -> str:
    if user is None:
        return "Unknown"
    return f"{user.mention} (`{user}` / `{user.id}`)"


class ModLog(commands.Cog):
    def __init__(self, bot: commands.Bot):
        self.bot = bot
        self.webhook: discord.Webhook | None = None

    async def cog_load(self):
        if MOD_LOG_WEBHOOK_URL:
            self.webhook = discord.Webhook.from_url(
                MOD_LOG_WEBHOOK_URL, session=self.bot.session
            )
        else:
            print("[mod_log] MOD_LOG_WEBHOOK_URL not set, mod logging disabled.")

    def _in_scope(self, guild: discord.Guild | None) -> bool:
        return guild is not None and guild.id == GUILD_ID

    async def log(self, **kwargs):
        await send_log(self.webhook, username=WEBHOOK_NAME, **kwargs)

    # ---------------------------------------------------------------- #
    # Message events (gateway-based, so we get content)
    # ---------------------------------------------------------------- #

    @commands.Cog.listener()
    async def on_message_delete(self, message: discord.Message):
        if not self._in_scope(message.guild) or message.author.bot:
            return
        content = message.content or "*(no text content — embed/attachment/etc.)*"
        if len(content) > 800:
            content = content[:800] + "…"
        await self.log(
            title="🗑️ Message Deleted",
            lines=[
                f"**Author:** {_fmt_user(message.author)}",
                f"**Channel:** {message.channel.mention}",
                f"**Content:**\n{content}",
            ],
            accent_color=discord.Color.orange(),
            footer=f"Message ID: {message.id}",
        )

    @commands.Cog.listener()
    async def on_bulk_message_delete(self, messages: list[discord.Message]):
        if not messages or not self._in_scope(messages[0].guild):
            return
        channel = messages[0].channel
        await self.log(
            title="🧹 Bulk Message Delete",
            lines=[
                f"**Channel:** {channel.mention}",
                f"**Count:** {len(messages)} messages purged",
            ],
            accent_color=discord.Color.orange(),
        )

    @commands.Cog.listener()
    async def on_message_edit(self, before: discord.Message, after: discord.Message):
        if not self._in_scope(before.guild) or before.author.bot:
            return
        if before.content == after.content:
            return  # embed load, pin, etc. — not a real edit

        def trim(s: str) -> str:
            s = s or "*(empty)*"
            return s if len(s) <= 400 else s[:400] + "…"

        await self.log(
            title="✏️ Message Edited",
            lines=[
                f"**Author:** {_fmt_user(before.author)}",
                f"**Channel:** {before.channel.mention}",
                f"**Before:**\n{trim(before.content)}",
                f"**After:**\n{trim(after.content)}",
            ],
            accent_color=discord.Color.gold(),
            footer=f"Message ID: {before.id}",
        )

    # ---------------------------------------------------------------- #
    # Audit-log driven events (bans, kicks, timeouts, role/channel mgmt)
    # ---------------------------------------------------------------- #

    @commands.Cog.listener()
    async def on_audit_log_entry_create(self, entry: discord.AuditLogEntry):
        if not self._in_scope(entry.guild):
            return

        handler = {
            discord.AuditLogAction.ban: self._on_ban,
            discord.AuditLogAction.unban: self._on_unban,
            discord.AuditLogAction.kick: self._on_kick,
            discord.AuditLogAction.member_update: self._on_member_update,
            discord.AuditLogAction.member_role_update: self._on_role_update,
            discord.AuditLogAction.channel_create: self._on_channel_create,
            discord.AuditLogAction.channel_delete: self._on_channel_delete,
            discord.AuditLogAction.role_create: self._on_role_create,
            discord.AuditLogAction.role_delete: self._on_role_delete,
        }.get(entry.action)

        if handler:
            await handler(entry)

    async def _on_ban(self, entry: discord.AuditLogEntry):
        await self.log(
            title="🔨 Member Banned",
            lines=[
                f"**User:** {_fmt_user(entry.target)}",
                f"**By:** {_fmt_user(entry.user)}",
                f"**Reason:** {entry.reason or 'No reason given'}",
            ],
            accent_color=discord.Color.red(),
        )

    async def _on_unban(self, entry: discord.AuditLogEntry):
        await self.log(
            title="⚖️ Member Unbanned",
            lines=[
                f"**User:** {_fmt_user(entry.target)}",
                f"**By:** {_fmt_user(entry.user)}",
            ],
            accent_color=discord.Color.green(),
        )

    async def _on_kick(self, entry: discord.AuditLogEntry):
        await self.log(
            title="👢 Member Kicked",
            lines=[
                f"**User:** {_fmt_user(entry.target)}",
                f"**By:** {_fmt_user(entry.user)}",
                f"**Reason:** {entry.reason or 'No reason given'}",
            ],
            accent_color=discord.Color.dark_orange(),
        )

    async def _on_member_update(self, entry: discord.AuditLogEntry):
        # Timeouts show up as a member_update entry with a
        # communication_disabled_until change.
        before = getattr(entry.before, "timed_out_until", None)
        after = getattr(entry.after, "timed_out_until", None)
        if before == after:
            return  # some other member_update (nickname, etc.) — skip, too noisy

        if after:
            await self.log(
                title="🔇 Member Timed Out",
                lines=[
                    f"**User:** {_fmt_user(entry.target)}",
                    f"**By:** {_fmt_user(entry.user)}",
                    f"**Until:** {discord.utils.format_dt(after, style='F')}",
                    f"**Reason:** {entry.reason or 'No reason given'}",
                ],
                accent_color=discord.Color.dark_gold(),
            )
        else:
            await self.log(
                title="🔊 Timeout Removed",
                lines=[
                    f"**User:** {_fmt_user(entry.target)}",
                    f"**By:** {_fmt_user(entry.user)}",
                ],
                accent_color=discord.Color.green(),
            )

    async def _on_role_update(self, entry: discord.AuditLogEntry):
        added = getattr(entry.after, "roles", None) or []
        removed = getattr(entry.before, "roles", None) or []
        lines = [f"**User:** {_fmt_user(entry.target)}", f"**By:** {_fmt_user(entry.user)}"]
        if added:
            lines.append("**Added:** " + ", ".join(r.mention for r in added))
        if removed:
            lines.append("**Removed:** " + ", ".join(r.mention for r in removed))
        await self.log(
            title="🎭 Member Roles Updated",
            lines=lines,
            accent_color=discord.Color.blurple(),
        )

    async def _on_channel_create(self, entry: discord.AuditLogEntry):
        await self.log(
            title="➕ Channel Created",
            lines=[
                f"**Channel:** {entry.target.mention if hasattr(entry.target, 'mention') else entry.target}",
                f"**By:** {_fmt_user(entry.user)}",
            ],
            accent_color=discord.Color.green(),
        )

    async def _on_channel_delete(self, entry: discord.AuditLogEntry):
        name = getattr(entry.target, "name", entry.target)
        await self.log(
            title="➖ Channel Deleted",
            lines=[
                f"**Channel:** #{name}",
                f"**By:** {_fmt_user(entry.user)}",
            ],
            accent_color=discord.Color.red(),
        )

    async def _on_role_create(self, entry: discord.AuditLogEntry):
        await self.log(
            title="➕ Role Created",
            lines=[
                f"**Role:** {entry.target.mention if hasattr(entry.target, 'mention') else entry.target}",
                f"**By:** {_fmt_user(entry.user)}",
            ],
            accent_color=discord.Color.green(),
        )

    async def _on_role_delete(self, entry: discord.AuditLogEntry):
        name = getattr(entry.target, "name", entry.target)
        await self.log(
            title="➖ Role Deleted",
            lines=[
                f"**Role:** {name}",
                f"**By:** {_fmt_user(entry.user)}",
            ],
            accent_color=discord.Color.red(),
        )


async def setup(bot: commands.Bot):
    await bot.add_cog(ModLog(bot))

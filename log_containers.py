"""
Small helper for sending compact "container" style log messages
(Discord Components V2) through an incoming webhook, instead of
classic embeds.
"""

from __future__ import annotations

import discord


class LogContainerView(discord.ui.LayoutView):
    """A one-off LayoutView wrapping a single Container.

    Components V2 requires every top-level message to be a LayoutView,
    so we build one fresh per log entry.
    """

    def __init__(self, container: discord.ui.Container):
        super().__init__(timeout=None)
        self.add_item(container)


def build_container(
    *,
    title: str,
    lines: list[str],
    accent_color: discord.Color,
    footer: str | None = None,
    thumbnail_url: str | None = None,
) -> LogContainerView:
    """Build a small container block: bold title, a few text lines, optional footer.

    `lines` are joined as separate markdown lines inside one TextDisplay so
    it renders as a single tight block rather than several bubbles.
    """
    body = f"### {title}\n" + "\n".join(lines)
    if footer:
        body += f"\n-# {footer}"

    text_display = discord.ui.TextDisplay(body)

    if thumbnail_url:
        section = discord.ui.Section(
            text_display,
            accessory=discord.ui.Thumbnail(thumbnail_url),
        )
        container = discord.ui.Container(section, accent_color=accent_color)
    else:
        container = discord.ui.Container(text_display, accent_color=accent_color)

    return LogContainerView(container)


async def send_log(
    webhook: discord.Webhook,
    *,
    title: str,
    lines: list[str],
    accent_color: discord.Color,
    footer: str | None = None,
    thumbnail_url: str | None = None,
    username: str | None = None,
    avatar_url: str | None = None,
) -> None:
    """Send a container-style log line to a webhook. Safe no-op if webhook is None."""
    if webhook is None:
        return

    view = build_container(
        title=title,
        lines=lines,
        accent_color=accent_color,
        footer=footer,
        thumbnail_url=thumbnail_url,
    )

    try:
        await webhook.send(
            view=view,
            username=username,
            avatar_url=avatar_url,
            allowed_mentions=discord.AllowedMentions.none(),
        )
    except discord.HTTPException as exc:
        print(f"[log_containers] failed to send log: {exc}")


// Helper to generate streaming links from various providers based on TMDB ID

export const STREAMING_PROVIDERS = [
    { name: "VidSrc.to", url: "https://vidsrc.to/embed" },
    { name: "VidSrc.me", url: "https://vidsrc.me/embed" },
    { name: "Embed.su", url: "https://embed.su/embed" },
    { name: "VidSrc.vip", url: "https://vidsrc.vip/embed" },
    { name: "SuperEmbed", url: "https://multiembed.mov" }, // Often a good fallback
    { name: "111Movies", url: "https://111movies.com/movie" },
];

export function getStreamingLinks(tmdbId: number, type: 'movie' | 'tv', season?: number, episode?: number): { name: string; url: string }[] {
    const links = [];

    if (type === 'movie') {
        links.push({ name: "▶️ VidSrc.to", url: `https://vidsrc.to/embed/movie/${tmdbId}` });
        links.push({ name: "▶️ VidSrc.me", url: `https://vidsrc.me/embed/movie/${tmdbId}` });
        links.push({ name: "▶️ Embed.su", url: `https://embed.su/embed/movie/${tmdbId}` });
        links.push({ name: "▶️ Vidsrc.cc", url: `https://vidsrc.cc/v2/embed/movie/${tmdbId}` });
        links.push({ name: "▶️ 2Embed", url: `https://www.2embed.cc/embed/${tmdbId}` });
    } else {
        // TV Shows
        const s = season || 1;
        const e = episode || 1;
        links.push({ name: "▶️ VidSrc.to", url: `https://vidsrc.to/embed/tv/${tmdbId}/${s}/${e}` });
        links.push({ name: "▶️ VidSrc.me", url: `https://vidsrc.me/embed/tv/${tmdbId}/${s}/${e}` });
        links.push({ name: "▶️ Embed.su", url: `https://embed.su/embed/tv/${tmdbId}/${s}/${e}` });
        links.push({ name: "▶️ Vidsrc.cc", url: `https://vidsrc.cc/v2/embed/tv/${tmdbId}/${s}/${e}` });
    }

    return links;
}

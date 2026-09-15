import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const repositoryRoot = path.resolve(scriptDirectory, "..");
const outputDirectory = path.join(repositoryRoot, "assets", "cards");
const config = JSON.parse(
  await readFile(path.join(repositoryRoot, "profile.config.json"), "utf8"),
);

const colors = {
  background: "#111827",
  surface: "#172033",
  border: "#334155",
  text: "#f8fafc",
  muted: "#94a3b8",
  cyan: "#72edf2",
  magenta: "#f472c4",
  htb: "#9fef00",
  monkeytype: "#e2b714",
};

const escapeXml = (value) =>
  String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");

const formatCompact = (value) =>
  new Intl.NumberFormat("en", {
    notation: value >= 10_000 ? "compact" : "standard",
    maximumFractionDigits: 1,
  }).format(value);

const formatHours = (seconds) =>
  `${new Intl.NumberFormat("en", { maximumFractionDigits: 0 }).format(seconds / 3600)}h`;

async function fetchText(url, headers = {}) {
  const response = await fetch(url, {
    headers: {
      Accept: "text/html,application/json",
      "User-Agent": "0xkholod-profile-card-generator/1.0",
      ...headers,
    },
    signal: AbortSignal.timeout(20_000),
  });

  if (!response.ok) {
    throw new Error(`${url} returned HTTP ${response.status}`);
  }

  return response.text();
}

async function fetchJson(url, headers = {}) {
  return JSON.parse(
    await fetchText(url, {
      Accept: "application/json",
      ...headers,
    }),
  );
}

async function fetchImageDataUrl(url) {
  if (!url) return undefined;

  const response = await fetch(url, {
    headers: {
      Accept: "image/avif,image/webp,image/png,image/jpeg,image/*",
      "User-Agent": "0xkholod-profile-card-generator/1.0",
    },
    signal: AbortSignal.timeout(20_000),
  });

  if (!response.ok) {
    throw new Error(`${url} returned HTTP ${response.status}`);
  }

  const contentType = response.headers.get("content-type")?.split(";")[0];
  if (!contentType?.startsWith("image/")) {
    throw new Error(`${url} did not return an image`);
  }

  const encoded = Buffer.from(await response.arrayBuffer()).toString("base64");
  return `data:${contentType};base64,${encoded}`;
}

function bestResult(results = []) {
  return results.reduce(
    (best, result) => (!best || result.wpm > best.wpm ? result : best),
    undefined,
  );
}

async function getMonkeytypeProfile() {
  const endpoint = `https://api.monkeytype.com/users/${encodeURIComponent(config.monkeytype.username)}/profile`;
  const payload = await fetchJson(endpoint);

  if (!payload?.data?.name || !payload?.data?.typingStats) {
    throw new Error("Monkeytype returned an unexpected profile payload");
  }

  const profile = payload.data;
  const personalBest = bestResult(
    Object.values(profile.personalBests ?? {}).flatMap((mode) =>
      Object.values(mode ?? {}).flatMap((results) => results ?? []),
    ),
  );

  if (!personalBest) {
    throw new Error("Monkeytype profile has no personal bests to render");
  }

  const selectedBadgeId = profile.inventory?.badges?.find((badge) => badge.selected)?.id;
  const avatarUrl =
    profile.discordId && profile.discordAvatar
      ? `https://cdn.discordapp.com/avatars/${profile.discordId}/${profile.discordAvatar}.png?size=128`
      : undefined;

  return {
    name: profile.name,
    wpm: personalBest.wpm,
    completedTests: profile.typingStats.completedTests,
    timeTyping: profile.typingStats.timeTyping,
    streak: profile.streak,
    badge:
      config.monkeytype.badgeLabels?.[String(selectedBadgeId)] ??
      (selectedBadgeId ? `Badge #${selectedBadgeId}` : "Monkeytype member"),
    avatarDataUrl: await fetchImageDataUrl(avatarUrl),
  };
}

function reviveNuxtReference(table, index, cache = new Map()) {
  if (typeof index !== "number") return index;
  if (index < 0) {
    return {
      [-1]: undefined,
      [-2]: Number.NaN,
      [-3]: Number.POSITIVE_INFINITY,
      [-4]: Number.NEGATIVE_INFINITY,
      [-5]: -0,
    }[index];
  }
  if (cache.has(index)) return cache.get(index);

  const raw = table[index];
  if (Array.isArray(raw)) {
    const wrapper = raw[0];
    if (
      typeof wrapper === "string" &&
      ["ShallowReactive", "Reactive", "Ref", "Readonly", "ShallowReadonly"].includes(wrapper)
    ) {
      return reviveNuxtReference(table, raw[1], cache);
    }

    const array = [];
    cache.set(index, array);
    for (const value of raw) {
      array.push(reviveNuxtReference(table, value, cache));
    }
    return array;
  }

  if (raw && typeof raw === "object") {
    const object = {};
    cache.set(index, object);
    for (const [key, value] of Object.entries(raw)) {
      object[key] = reviveNuxtReference(table, value, cache);
    }
    return object;
  }

  return raw;
}

function extractHackTheBoxProfile(html) {
  const match = html.match(
    /<script[^>]+id=["']__NUXT_DATA__["'][^>]*>([\s\S]*?)<\/script>/,
  );
  if (!match) throw new Error("HTB public profile did not contain Nuxt profile data");

  const table = JSON.parse(match[1]);
  const cache = new Map();
  const revive = (index) => reviveNuxtReference(table, index, cache);

  let profile;
  const credentials = [];
  const badges = [];

  for (let index = 0; index < table.length; index += 1) {
    const raw = table[index];
    if (!raw || Array.isArray(raw) || typeof raw !== "object") continue;
    const keys = new Set(Object.keys(raw));

    if (keys.has("account_id") && keys.has("full_name") && keys.has("is_public")) {
      const candidate = revive(index);
      if (candidate.id === config.hackthebox.profileId) profile = candidate;
    }

    if (keys.has("identifier") && keys.has("shortcode") && keys.has("title")) {
      credentials.push(revive(index));
    }

    if (keys.has("awarded_at") && keys.has("platform") && keys.has("description")) {
      const badge = revive(index);
      if (badge.awarded) badges.push(badge);
    }
  }

  if (!profile) throw new Error("Unable to identify the requested HTB public profile");

  const uniqueCredentials = [...new Map(credentials.map((item) => [item.identifier, item])).values()];
  const uniqueBadges = [...new Map(badges.map((item) => [`${item.platform}:${item.id}`, item])).values()];

  const credentialLabels = uniqueCredentials.map((credential) => {
    if (credential.shortcode === "ACADEMY-CPTS-EXAM") return "HTB CPTS";
    if (credential.shortcode === "DANTE") return "Dante Pro Lab";
    return credential.title;
  });
  const cpts = credentialLabels.find((label) => label.includes("CPTS"));
  const dante = credentialLabels.find((label) => label.toLowerCase().includes("dante"));

  return {
    name: profile.name,
    country: profile.country?.name ?? "Spain",
    avatarUrl: profile.avatar ?? profile.avatar_thumb,
    credentials: [cpts, dante, ...credentialLabels].filter(
      (label, index, labels) => label && labels.indexOf(label) === index,
    ),
    badgeCount: uniqueBadges.length,
  };
}

async function getHackTheBoxProfile() {
  const apiBase = `https://profile.hackthebox.com/api/v1/public/profile/${encodeURIComponent(config.hackthebox.profileId)}`;
  const apiHeaders = { Referer: "https://profile.hackthebox.com/" };
  const [html, certificationsPayload, achievementsPayload, labsBadgesPayload] =
    await Promise.all([
      fetchText(config.hackthebox.profileUrl),
      fetchJson(
        `${apiBase}/sections/certificates/internal/certifications`,
        apiHeaders,
      ),
      fetchJson(
        `${apiBase}/sections/certificates/internal/achievements`,
        apiHeaders,
      ),
      fetchJson(`${apiBase}/badges/labs`, apiHeaders),
    ]);

  const profile = extractHackTheBoxProfile(html);
  const certifications = certificationsPayload.data ?? [];
  const achievements = achievementsPayload.data ?? [];
  const machineCategory = (labsBadgesPayload.categories ?? []).find(
    (category) => category.name === "Machine",
  );
  const machineMilestones = (machineCategory?.badges ?? [])
    .filter((badge) => badge.awarded)
    .map((badge) => badge.description?.match(/^Owned (\d+) machines$/i)?.[1])
    .filter(Boolean)
    .map(Number);
  const machineCount = machineMilestones.length
    ? `${Math.max(...machineMilestones)}+`
    : "—";
  const proLabCount = achievements.filter(
    (achievement) => achievement.course?.type === "ProLab",
  ).length;
  const hasCpts = certifications.some(
    (certification) => certification.shortcode === "ACADEMY-CPTS-EXAM",
  );
  const hasDante = achievements.some(
    (achievement) => achievement.shortcode === "DANTE",
  );

  return {
    ...profile,
    cptsLabel: hasCpts ? "CPTS" : profile.credentials[0] ?? "CPTS",
    danteLabel: hasDante ? "DANTE" : profile.credentials[1] ?? "DANTE",
    machineCount,
    proLabCount,
    avatarDataUrl: await fetchImageDataUrl(profile.avatarUrl),
  };
}

function renderAvatar({ id, image, x, y, size, accent, initials = "0X" }) {
  const radius = size / 2;
  const centerX = x + radius;
  const centerY = y + radius;
  const imageMarkup = image
    ? `<image href="${escapeXml(image)}" x="${x}" y="${y}" width="${size}" height="${size}" preserveAspectRatio="xMidYMid slice" clip-path="url(#${id}-avatar-clip)"/>`
    : `<text x="${centerX}" y="${centerY + 6}" text-anchor="middle" fill="${accent}" font-family="ui-monospace,SFMono-Regular,Consolas,monospace" font-size="17" font-weight="800">${escapeXml(initials)}</text>`;

  return `<defs>
    <clipPath id="${id}-avatar-clip"><circle cx="${centerX}" cy="${centerY}" r="${radius - 2}"/></clipPath>
  </defs>
  <circle cx="${centerX}" cy="${centerY}" r="${radius}" fill="#0b1220" stroke="${accent}" stroke-width="2" stroke-opacity=".7"/>
  ${imageMarkup}
  <circle cx="${centerX}" cy="${centerY}" r="${radius - 2}" fill="none" stroke="#ffffff" stroke-width="1" stroke-opacity=".12"/>`;
}

function cardShell({ id, accent, label, icon, body }) {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="460" height="190" viewBox="0 0 460 190" role="img" aria-labelledby="${id}-title ${id}-description">
  <title id="${id}-title">${escapeXml(label)}</title>
  <desc id="${id}-description">Live public profile statistics for 0xkholod</desc>
  <defs>
    <linearGradient id="${id}-background" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0" stop-color="${colors.surface}"/>
      <stop offset="1" stop-color="${colors.background}"/>
    </linearGradient>
    <radialGradient id="${id}-glow" cx="0" cy="0" r="1" gradientUnits="userSpaceOnUse" gradientTransform="translate(395 30) rotate(135) scale(175 120)">
      <stop stop-color="${accent}" stop-opacity=".18"/>
      <stop offset="1" stop-color="${accent}" stop-opacity="0"/>
    </radialGradient>
    <filter id="${id}-shadow" x="-20%" y="-20%" width="140%" height="140%">
      <feDropShadow dx="0" dy="8" stdDeviation="14" flood-color="#020617" flood-opacity=".45"/>
    </filter>
  </defs>
  <rect x="5" y="5" width="450" height="180" rx="20" fill="url(#${id}-background)" stroke="${colors.border}" stroke-width="2" filter="url(#${id}-shadow)"/>
  <rect x="5" y="5" width="450" height="180" rx="20" fill="url(#${id}-glow)"/>
  <g transform="translate(164 15) scale(.58)">${icon}</g>
  <text x="253" y="35" text-anchor="middle" fill="${accent}" font-family="ui-monospace,SFMono-Regular,Consolas,monospace" font-size="11" font-weight="600" letter-spacing="1.8">${escapeXml(label)}</text>
  ${body}
</svg>`;
}

function renderMonkeytypeCard(profile) {
  const icon = `<path d="M4 12h36v25H4z" fill="none" stroke="${colors.monkeytype}" stroke-width="2"/>
    <path d="M10 19h3m4 0h3m4 0h3m4 0h3M10 25h3m4 0h3m4 0h3m4 0h3M14 31h20" stroke="${colors.monkeytype}" stroke-width="2.2" stroke-linecap="round"/>`;
  const body = `${renderAvatar({ id: "monkeytype", image: profile.avatarDataUrl, x: 30, y: 56, size: 54, accent: colors.monkeytype })}
  <text x="98" y="77" fill="${colors.text}" font-family="Inter,Segoe UI,sans-serif" font-size="20" font-weight="500">${escapeXml(profile.name)}</text>
  <rect x="98" y="88" width="118" height="22" rx="11" fill="#22d3ee16" stroke="${colors.cyan}" stroke-opacity=".58"/>
  <text x="157" y="102.5" text-anchor="middle" fill="${colors.cyan}" font-family="ui-monospace,SFMono-Regular,Consolas,monospace" font-size="9" font-weight="650" letter-spacing=".55">${escapeXml(profile.badge)}</text>
  <g>
    <rect x="17" y="136" width="102" height="35" rx="9" fill="#ffffff05" stroke="${colors.border}"/>
    <text x="68" y="151" text-anchor="middle" fill="${colors.text}" font-family="Inter,Segoe UI,sans-serif" font-size="14" font-weight="550">${profile.streak}d</text>
    <text x="68" y="164" text-anchor="middle" fill="${colors.muted}" font-family="ui-monospace,SFMono-Regular,Consolas,monospace" font-size="7" letter-spacing="1">STREAK</text>
  </g>
  <g>
    <rect x="125" y="136" width="102" height="35" rx="9" fill="#ffffff05" stroke="${colors.border}"/>
    <text x="176" y="151" text-anchor="middle" fill="${colors.text}" font-family="Inter,Segoe UI,sans-serif" font-size="14" font-weight="550">${formatHours(profile.timeTyping)}</text>
    <text x="176" y="164" text-anchor="middle" fill="${colors.muted}" font-family="ui-monospace,SFMono-Regular,Consolas,monospace" font-size="7" letter-spacing="1">TYPING</text>
  </g>
  <g>
    <rect x="233" y="136" width="102" height="35" rx="9" fill="#ffffff05" stroke="${colors.border}"/>
    <text x="284" y="151" text-anchor="middle" fill="${colors.text}" font-family="Inter,Segoe UI,sans-serif" font-size="14" font-weight="550">${formatCompact(profile.completedTests)}</text>
    <text x="284" y="164" text-anchor="middle" fill="${colors.muted}" font-family="ui-monospace,SFMono-Regular,Consolas,monospace" font-size="7" letter-spacing="1">TESTS</text>
  </g>
  <g>
    <rect x="341" y="136" width="102" height="35" rx="9" fill="#e2b71409" stroke="${colors.monkeytype}" stroke-opacity=".32"/>
    <text x="392" y="151" text-anchor="middle" fill="${colors.monkeytype}" font-family="Inter,Segoe UI,sans-serif" font-size="14" font-weight="600">${Math.round(profile.wpm)} WPM</text>
    <text x="392" y="164" text-anchor="middle" fill="${colors.muted}" font-family="ui-monospace,SFMono-Regular,Consolas,monospace" font-size="7" letter-spacing="1">PB</text>
  </g>
  <circle cx="432" cy="24" r="3.5" fill="${colors.cyan}"><animate attributeName="opacity" values=".35;1;.35" dur="2.4s" repeatCount="indefinite"/></circle>`;

  return cardShell({
    id: "monkeytype",
    accent: colors.monkeytype,
    label: "MONKEYTYPE",
    icon,
    body,
  });
}

function renderHackTheBoxCard(profile) {
  const icon = `<path d="M22 3 40 13v21L22 44 4 34V13Z" fill="none" stroke="${colors.htb}" stroke-width="2"/>
    <path d="m22 3 18 10-18 10L4 13m18 10v21" fill="none" stroke="${colors.htb}" stroke-width="2"/>`;
  const body = `${renderAvatar({ id: "hackthebox", image: profile.avatarDataUrl, x: 30, y: 56, size: 54, accent: colors.htb })}
  <text x="98" y="77" fill="${colors.text}" font-family="Inter,Segoe UI,sans-serif" font-size="20" font-weight="500">${escapeXml(profile.name)}</text>
  <rect x="98" y="88" width="58" height="22" rx="11" fill="#9fef0012" stroke="${colors.htb}" stroke-opacity=".65"/>
  <text x="127" y="102.5" text-anchor="middle" fill="${colors.htb}" font-family="ui-monospace,SFMono-Regular,Consolas,monospace" font-size="9" font-weight="650" letter-spacing=".7">${escapeXml(profile.cptsLabel)}</text>
  <rect x="164" y="88" width="68" height="22" rx="11" fill="#72edf210" stroke="${colors.cyan}" stroke-opacity=".48"/>
  <text x="198" y="102.5" text-anchor="middle" fill="${colors.cyan}" font-family="ui-monospace,SFMono-Regular,Consolas,monospace" font-size="9" font-weight="650" letter-spacing=".7">${escapeXml(profile.danteLabel)}</text>
  <g>
    <title>Machines owned: ${escapeXml(profile.machineCount)}</title>
    <rect x="120" y="138" width="92" height="33" rx="9" fill="#9fef000a" stroke="${colors.htb}" stroke-opacity=".32"/>
    <g transform="translate(137 147)" fill="none" stroke="${colors.htb}" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
      <rect x="0" y="0" width="18" height="12" rx="2"/><path d="M6 16h6M9 12v4M4 5l2 2-2 2m5 0h4"/>
    </g>
    <text x="182" y="159.5" text-anchor="middle" fill="${colors.htb}" font-family="Inter,Segoe UI,sans-serif" font-size="16" font-weight="600">${escapeXml(profile.machineCount)}</text>
  </g>
  <g>
    <title>Pro Labs completed: ${profile.proLabCount}</title>
    <rect x="248" y="138" width="92" height="33" rx="9" fill="#72edf209" stroke="${colors.cyan}" stroke-opacity=".28"/>
    <g transform="translate(264 146)" fill="none" stroke="${colors.cyan}" stroke-width="1.5" stroke-linejoin="round">
      <path d="m9 0 9 5v10l-9 5-9-5V5Zm0 0v10m9-5-9 5-9-5m9 5v10"/>
    </g>
    <text x="313" y="159.5" text-anchor="middle" fill="${colors.cyan}" font-family="Inter,Segoe UI,sans-serif" font-size="16" font-weight="600">${profile.proLabCount}</text>
  </g>
  <circle cx="432" cy="24" r="3.5" fill="${colors.htb}"><animate attributeName="opacity" values=".35;1;.35" dur="2.4s" repeatCount="indefinite"/></circle>`;

  return cardShell({
    id: "hackthebox",
    accent: colors.htb,
    label: "HACK THE BOX",
    icon,
    body,
  });
}

async function main() {
  await mkdir(outputDirectory, { recursive: true });

  const [monkeytypeResult, hackTheBoxResult] = await Promise.allSettled([
    getMonkeytypeProfile(),
    getHackTheBoxProfile(),
  ]);

  if (monkeytypeResult.status === "fulfilled") {
    await writeFile(
      path.join(outputDirectory, "monkeytype.svg"),
      `${renderMonkeytypeCard(monkeytypeResult.value)}\n`,
    );
    console.log("Generated Monkeytype card from the official public profile API.");
  } else {
    throw new Error(`Monkeytype card generation failed: ${monkeytypeResult.reason}`);
  }

  const hackTheBoxProfile =
    hackTheBoxResult.status === "fulfilled"
      ? hackTheBoxResult.value
      : {
          name: "0xkholod",
          country: "Spain",
          credentials: config.hackthebox.fallbackCredentials,
          cptsLabel: "CPTS",
          danteLabel: "DANTE",
          machineCount: config.hackthebox.fallbackMachineCount,
          proLabCount: config.hackthebox.fallbackProLabCount,
          avatarDataUrl: await fetchImageDataUrl(config.hackthebox.fallbackAvatarUrl),
        };

  await writeFile(
    path.join(outputDirectory, "hackthebox.svg"),
    `${renderHackTheBoxCard(hackTheBoxProfile)}\n`,
  );

  if (hackTheBoxResult.status === "fulfilled") {
    console.log("Generated Hack The Box card from the public profile payload.");
  } else {
    console.warn(`HTB live sync unavailable; rendered verified fallback data: ${hackTheBoxResult.reason}`);
  }
}

await main();

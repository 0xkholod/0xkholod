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
  return `<svg xmlns="http://www.w3.org/2000/svg" width="560" height="220" viewBox="0 0 560 220" role="img" aria-labelledby="${id}-title ${id}-description">
  <title id="${id}-title">${escapeXml(label)}</title>
  <desc id="${id}-description">Live public profile statistics for 0xkholod</desc>
  <defs>
    <linearGradient id="${id}-background" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0" stop-color="${colors.surface}"/>
      <stop offset="1" stop-color="${colors.background}"/>
    </linearGradient>
    <radialGradient id="${id}-glow" cx="0" cy="0" r="1" gradientUnits="userSpaceOnUse" gradientTransform="translate(480 35) rotate(135) scale(210 145)">
      <stop stop-color="${accent}" stop-opacity=".18"/>
      <stop offset="1" stop-color="${accent}" stop-opacity="0"/>
    </radialGradient>
    <filter id="${id}-shadow" x="-20%" y="-20%" width="140%" height="140%">
      <feDropShadow dx="0" dy="8" stdDeviation="14" flood-color="#020617" flood-opacity=".45"/>
    </filter>
  </defs>
  <rect x="6" y="6" width="548" height="208" rx="24" fill="url(#${id}-background)" stroke="${colors.border}" stroke-width="2" filter="url(#${id}-shadow)"/>
  <rect x="6" y="6" width="548" height="208" rx="24" fill="url(#${id}-glow)"/>
  <path d="M30 190H530" stroke="${accent}" stroke-opacity=".23"/>
  <g transform="translate(30 27)">${icon}</g>
  <text x="82" y="39" fill="${accent}" font-family="ui-monospace,SFMono-Regular,Consolas,monospace" font-size="13" font-weight="700" letter-spacing="2">${escapeXml(label)}</text>
  ${body}
</svg>`;
}

function renderMonkeytypeCard(profile) {
  const icon = `<path d="M4 12h36v25H4z" fill="none" stroke="${colors.monkeytype}" stroke-width="2"/>
    <path d="M10 19h3m4 0h3m4 0h3m4 0h3M10 25h3m4 0h3m4 0h3m4 0h3M14 31h20" stroke="${colors.monkeytype}" stroke-width="2.2" stroke-linecap="round"/>`;
  const body = `${renderAvatar({ id: "monkeytype", image: profile.avatarDataUrl, x: 30, y: 64, size: 62, accent: colors.monkeytype })}
  <text x="108" y="87" fill="${colors.text}" font-family="Inter,Segoe UI,sans-serif" font-size="25" font-weight="750">${escapeXml(profile.name)}</text>
  <rect x="108" y="98" width="132" height="25" rx="12.5" fill="#22d3ee20" stroke="${colors.cyan}" stroke-opacity=".65"/>
  <path d="M120 114c-5-5 1-9 2-13 6 5 7 9 3 13-1 2-3 2-5 0Z" fill="${colors.cyan}"/>
  <text x="132" y="115" fill="${colors.cyan}" font-family="ui-monospace,SFMono-Regular,Consolas,monospace" font-size="10" font-weight="750" letter-spacing=".5">${escapeXml(profile.badge)}</text>
  <path d="M154 144v39M280 144v39M406 144v39" stroke="${colors.border}" stroke-width="1"/>
  <text x="30" y="165" fill="${colors.text}" font-family="Inter,Segoe UI,sans-serif" font-size="21" font-weight="800">${profile.streak} days</text>
  <text x="30" y="183" fill="${colors.muted}" font-family="ui-monospace,SFMono-Regular,Consolas,monospace" font-size="9" letter-spacing="1">CURRENT STREAK</text>
  <text x="174" y="165" fill="${colors.text}" font-family="Inter,Segoe UI,sans-serif" font-size="21" font-weight="800">${formatHours(profile.timeTyping)}</text>
  <text x="174" y="183" fill="${colors.muted}" font-family="ui-monospace,SFMono-Regular,Consolas,monospace" font-size="9" letter-spacing="1">TIME TYPING</text>
  <text x="300" y="165" fill="${colors.text}" font-family="Inter,Segoe UI,sans-serif" font-size="21" font-weight="800">${formatCompact(profile.completedTests)}</text>
  <text x="300" y="183" fill="${colors.muted}" font-family="ui-monospace,SFMono-Regular,Consolas,monospace" font-size="9" letter-spacing="1">TESTS COMPLETED</text>
  <text x="426" y="165" fill="${colors.monkeytype}" font-family="Inter,Segoe UI,sans-serif" font-size="21" font-weight="850">${Math.round(profile.wpm)} WPM</text>
  <text x="426" y="183" fill="${colors.muted}" font-family="ui-monospace,SFMono-Regular,Consolas,monospace" font-size="9" letter-spacing="1">PERSONAL BEST</text>
  <circle cx="523" cy="31" r="4" fill="${colors.cyan}"><animate attributeName="opacity" values=".35;1;.35" dur="2.4s" repeatCount="indefinite"/></circle>`;

  return cardShell({
    id: "monkeytype",
    accent: colors.monkeytype,
    label: "MONKEYTYPE / LIVE",
    icon,
    body,
  });
}

function renderHackTheBoxCard(profile) {
  const icon = `<path d="M22 3 40 13v21L22 44 4 34V13Z" fill="none" stroke="${colors.htb}" stroke-width="2"/>
    <path d="m22 3 18 10-18 10L4 13m18 10v21" fill="none" stroke="${colors.htb}" stroke-width="2"/>`;
  const body = `${renderAvatar({ id: "hackthebox", image: profile.avatarDataUrl, x: 30, y: 64, size: 62, accent: colors.htb })}
  <text x="108" y="87" fill="${colors.text}" font-family="Inter,Segoe UI,sans-serif" font-size="25" font-weight="750">${escapeXml(profile.name)}</text>
  <rect x="108" y="98" width="76" height="25" rx="12.5" fill="#9fef0018" stroke="${colors.htb}" stroke-opacity=".7"/>
  <path d="m120 108 4 4 7-8" fill="none" stroke="${colors.htb}" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
  <text x="137" y="115" fill="${colors.htb}" font-family="ui-monospace,SFMono-Regular,Consolas,monospace" font-size="10" font-weight="750" letter-spacing=".7">${escapeXml(profile.cptsLabel)}</text>
  <rect x="192" y="98" width="82" height="25" rx="12.5" fill="#72edf212" stroke="${colors.cyan}" stroke-opacity=".5"/>
  <path d="M205 105h8v10h-8zM207 103h4v3" fill="none" stroke="${colors.cyan}" stroke-width="1.4"/>
  <text x="219" y="115" fill="${colors.cyan}" font-family="ui-monospace,SFMono-Regular,Consolas,monospace" font-size="10" font-weight="750" letter-spacing=".7">${escapeXml(profile.danteLabel)}</text>
  <rect x="30" y="143" width="244" height="42" rx="12" fill="#9fef000b" stroke="${colors.htb}" stroke-opacity=".28"/>
  <text x="48" y="170" fill="${colors.htb}" font-family="Inter,Segoe UI,sans-serif" font-size="25" font-weight="850">${escapeXml(profile.machineCount)}</text>
  <text x="110" y="166" fill="${colors.text}" font-family="Inter,Segoe UI,sans-serif" font-size="13" font-weight="700">MACHINES OWNED</text>
  <rect x="286" y="143" width="244" height="42" rx="12" fill="#72edf20a" stroke="${colors.cyan}" stroke-opacity=".25"/>
  <text x="304" y="170" fill="${colors.cyan}" font-family="Inter,Segoe UI,sans-serif" font-size="25" font-weight="850">${profile.proLabCount}</text>
  <text x="340" y="166" fill="${colors.text}" font-family="Inter,Segoe UI,sans-serif" font-size="13" font-weight="700">PRO LAB COMPLETED</text>
  <circle cx="523" cy="31" r="4" fill="${colors.htb}"><animate attributeName="opacity" values=".35;1;.35" dur="2.4s" repeatCount="indefinite"/></circle>`;

  return cardShell({
    id: "hackthebox",
    accent: colors.htb,
    label: "HACK THE BOX / LIVE",
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

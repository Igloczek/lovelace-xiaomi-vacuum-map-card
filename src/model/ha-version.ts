/**
 * `true` when a Home Assistant version is older than `target` (`year.month` or `year.month.patch`).
 * Versions are compared numerically: as text "2026.10.0" sorts below "2026.4". A missing or
 * unreadable version counts as the newest, so the current behaviour is the default.
 */
export function isHaVersionBefore(version: string | undefined, target: string): boolean {
    const parse = (value: string): number[] | undefined => {
        const match = /^(\d+)\.(\d+)(?:\.(\d+))?/.exec(value.trim());
        return match ? [Number(match[1]), Number(match[2]), Number(match[3] ?? 0)] : undefined;
    };
    const current = version === undefined ? undefined : parse(version);
    const limit = parse(target);
    if (!current || !limit) return false;
    for (let i = 0; i < 3; i++) {
        if (current[i] !== limit[i]) return current[i] < limit[i];
    }
    return false;
}

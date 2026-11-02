/**
 * Nhận diện profile/tweet X bị suspended, restrict, mất acc — để agent skip → next.
 */

function pageBlob(root: ParentNode = document): string {
  const column =
    (root as Document | Element).querySelector?.('[data-testid="primaryColumn"]') ||
    (root as Document | Element).querySelector?.('main[role="main"]') ||
    (root as Document).body;
  return (column?.textContent || "").replace(/\s+/g, " ").trim().slice(0, 4000);
}

/**
 * Trả mã lỗi ổn định khi trang X báo acc/bài không dùng được.
 * null = không thấy tín hiệu rõ.
 */
export function detectAccountUnavailable(root: ParentNode = document): string | null {
  const blob = pageBlob(root);
  if (!blob) return null;

  if (
    /account suspended|has been suspended|tài khoản đã bị đình chỉ|bị đình chỉ/i.test(blob)
  ) {
    return "profile_suspended";
  }
  if (
    /account doesn.?t exist|doesn.?t exist\.?\s*try searching|không tồn tại|try searching for another/i.test(
      blob,
    )
  ) {
    return "profile_missing";
  }
  if (
    /temporarily restricted|may have been temporarily restricted|unusually large number of posts|hồ sơ.*hạn chế|bị hạn chế tạm thời/i.test(
      blob,
    )
  ) {
    return "profile_restricted";
  }
  // Empty error state thường đi kèm restrict/sus trên profile
  if (
    /something went wrong\.?\s*try reloading|đã xảy ra lỗi\.?\s*hãy thử tải lại/i.test(blob) &&
    (/caution:|this profile|hồ sơ này|profile may/i.test(blob) ||
      !document.querySelector('[data-testid="UserName"], [data-testid="User-Name"]'))
  ) {
    return "profile_unavailable";
  }
  if (
    /this post is from an account that no longer exists|bài đăng.*không còn tồn tại|post.*(unavailable|deleted|not available)/i.test(
      blob,
    )
  ) {
    return "tweet_unavailable";
  }
  return null;
}

export function isAccountUnavailableError(error: string | undefined | null): boolean {
  const e = (error || "").trim();
  return (
    e === "profile_suspended" ||
    e === "profile_restricted" ||
    e === "profile_missing" ||
    e === "profile_unavailable" ||
    e === "tweet_unavailable"
  );
}

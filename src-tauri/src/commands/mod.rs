pub mod dialog;
pub mod fs;
pub mod window;
pub mod sync;
pub mod mupdf;
pub mod ai;
pub mod ai_companion;
pub mod siwc;
pub mod dictionary;
pub mod ocr_models;
pub mod txt_stream;
pub mod android;
pub mod security;

pub use dialog::*;
pub use fs::*;
pub use window::*;
pub use sync::*;
pub use mupdf::*;
pub use ai::*;
pub use ai_companion::*;
pub use siwc::*;
pub use dictionary::*;
pub use ocr_models::*;
pub use txt_stream::*;
pub use android::*;
pub use security::*;

/// Normalizes an optional locale string into `"en"` or `"zh-CN"`.
/// Defaults to `"zh-CN"` when `locale` is `None`, empty, or unrecognized.
pub(crate) fn resolve_locale(locale: Option<&str>) -> &'static str {
    let Some(raw) = locale else {
        return "zh-CN";
    };
    let normalized = raw.trim().to_ascii_lowercase().replace('_', "-");
    if normalized == "en" || normalized.starts_with("en-") {
        "en"
    } else {
        "zh-CN"
    }
}

/// Returns `true` when `locale` resolves to English (`"en"`).
pub(crate) fn is_en_locale(locale: Option<&str>) -> bool {
    resolve_locale(locale) == "en"
}

/// Picks the localized string matching `is_en`.
pub(crate) fn l10n<'a>(is_en: bool, zh: &'a str, en: &'a str) -> &'a str {
    if is_en { en } else { zh }
}

/// Returns `true` if `host` refers to loopback, link-local, RFC1918/ULA private,
/// CGNAT, or local-domain addresses that public HTTPS redirects must not target.
pub(crate) fn is_private_or_local_host(host: &str) -> bool {
    let trimmed = host.trim().trim_start_matches('[').trim_end_matches(']').to_ascii_lowercase();
    if trimmed.is_empty()
        || trimmed == "localhost"
        || trimmed.ends_with(".localhost")
        || trimmed.ends_with(".local")
        || trimmed.ends_with(".internal")
    {
        return true;
    }
    if let Ok(ip) = trimmed.parse::<std::net::IpAddr>() {
        return match ip {
            std::net::IpAddr::V4(v4) => {
                let octets = v4.octets();
                let is_cgnat = octets[0] == 100 && (octets[1] & 0b1100_0000) == 64;
                v4.is_loopback()
                    || v4.is_private()
                    || v4.is_link_local()
                    || v4.is_unspecified()
                    || v4.is_broadcast()
                    || v4.is_multicast()
                    || is_cgnat
            }
            std::net::IpAddr::V6(v6) => {
                if let Some(v4) = v6.to_ipv4_mapped() {
                    let octets = v4.octets();
                    let is_cgnat = octets[0] == 100 && (octets[1] & 0b1100_0000) == 64;
                    return v4.is_loopback()
                        || v4.is_private()
                        || v4.is_link_local()
                        || v4.is_unspecified()
                        || v4.is_broadcast()
                        || v4.is_multicast()
                        || is_cgnat;
                }
                let seg0 = v6.segments()[0];
                let is_unique_local = (seg0 & 0xfe00) == 0xfc00;
                let is_link_local = (seg0 & 0xffc0) == 0xfe80;
                v6.is_loopback()
                    || v6.is_unspecified()
                    || v6.is_multicast()
                    || is_unique_local
                    || is_link_local
            }
        };
    }
    false
}

/// Validates a redirect target URL for public HTTPS requests.
pub(crate) fn is_safe_public_https_redirect(url: &reqwest::Url) -> Result<(), String> {
    if url.scheme() != "https" {
        return Err(format!("Blocked redirect to non-HTTPS scheme '{}'", url.scheme()));
    }
    let host = url.host_str().unwrap_or("");
    if host.is_empty() || is_private_or_local_host(host) {
        return Err(format!("Blocked redirect to private or local host '{}'", host));
    }
    Ok(())
}

/// Builds a `reqwest::redirect::Policy` that caps redirect depth and blocks
/// downgrades to non-HTTPS or redirects into private/loopback/link-local hosts.
pub(crate) fn safe_https_redirect_policy(max_hops: usize, allow_initial_loopback_http: bool) -> reqwest::redirect::Policy {
    reqwest::redirect::Policy::custom(move |attempt| {
        if attempt.previous().len() >= max_hops {
            return attempt.error("Too many HTTP redirects");
        }
        let target = attempt.url();
        if allow_initial_loopback_http {
            let initial_is_loopback = attempt
                .previous()
                .first()
                .and_then(|u| u.host_str())
                .map(|h| matches!(h, "127.0.0.1" | "localhost" | "::1" | "[::1]"))
                .unwrap_or(false);
            if initial_is_loopback && matches!(target.scheme(), "http" | "https") {
                let target_host = target.host_str().unwrap_or("");
                if matches!(target_host, "127.0.0.1" | "localhost" | "::1" | "[::1]") {
                    return attempt.follow();
                }
                if target.scheme() == "http" {
                    return attempt.error("Blocked redirect from loopback TTS endpoint to non-loopback HTTP host");
                }
            }
        }
        match is_safe_public_https_redirect(target) {
            Ok(()) => attempt.follow(),
            Err(msg) => attempt.error(msg),
        }
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_resolve_locale_defaults_and_variants() {
        assert_eq!(resolve_locale(None), "zh-CN");
        assert_eq!(resolve_locale(Some("")), "zh-CN");
        assert_eq!(resolve_locale(Some("  ")), "zh-CN");
        assert_eq!(resolve_locale(Some("zh-CN")), "zh-CN");
        assert_eq!(resolve_locale(Some("zh_CN")), "zh-CN");
        assert_eq!(resolve_locale(Some("zh")), "zh-CN");
        assert_eq!(resolve_locale(Some("fr-FR")), "zh-CN");
        assert_eq!(resolve_locale(Some("en")), "en");
        assert_eq!(resolve_locale(Some("EN")), "en");
        assert_eq!(resolve_locale(Some("en-US")), "en");
        assert_eq!(resolve_locale(Some("en_GB")), "en");
        assert!(!is_en_locale(None));
        assert!(!is_en_locale(Some("zh-CN")));
        assert!(is_en_locale(Some("en")));
        assert!(is_en_locale(Some("en-US")));
    }

    #[test]
    fn test_safe_public_https_redirect_blocks_private_and_http() {
        assert!(is_private_or_local_host("localhost"));
        assert!(is_private_or_local_host("sub.localhost"));
        assert!(is_private_or_local_host("printer.local"));
        assert!(is_private_or_local_host("metadata.internal"));
        assert!(is_private_or_local_host("127.0.0.1"));
        assert!(is_private_or_local_host("169.254.169.254"));
        assert!(is_private_or_local_host("10.0.0.1"));
        assert!(is_private_or_local_host("172.16.5.1"));
        assert!(is_private_or_local_host("192.168.1.1"));
        assert!(is_private_or_local_host("100.64.0.1"));
        assert!(is_private_or_local_host("[::1]"));
        assert!(is_private_or_local_host("[fe80::1]"));
        assert!(is_private_or_local_host("[fc00::1]"));
        assert!(!is_private_or_local_host("raw.githubusercontent.com"));
        assert!(!is_private_or_local_host("cdn.jsdelivr.net"));

        assert!(is_safe_public_https_redirect(&reqwest::Url::parse("https://raw.githubusercontent.com/skywind3000/ECDICT/master/ecdict.csv").unwrap()).is_ok());
        assert!(is_safe_public_https_redirect(&reqwest::Url::parse("http://raw.githubusercontent.com/ecdict.csv").unwrap()).is_err());
        assert!(is_safe_public_https_redirect(&reqwest::Url::parse("https://127.0.0.1/secret").unwrap()).is_err());
        assert!(is_safe_public_https_redirect(&reqwest::Url::parse("https://169.254.169.254/latest/meta-data").unwrap()).is_err());
        assert!(is_safe_public_https_redirect(&reqwest::Url::parse("https://localhost/admin").unwrap()).is_err());
        assert!(is_safe_public_https_redirect(&reqwest::Url::parse("https://[::1]/admin").unwrap()).is_err());
    }
}


use sha2::{Digest, Sha256};
use std::collections::hash_map::DefaultHasher;
use std::hash::Hasher;

// One streaming pass for the stable content ID and the pre-1.0 native compatibility ID.
pub(crate) struct ContentHasher {
    sha256: Sha256,
    legacy: DefaultHasher,
}

impl ContentHasher {
    pub(crate) fn new() -> Self {
        Self { sha256: Sha256::new(), legacy: DefaultHasher::new() }
    }
    pub(crate) fn update(&mut self, bytes: &[u8]) {
        self.sha256.update(bytes);
        self.legacy.write(bytes);
    }
    pub(crate) fn finish(self, size: u64) -> (String, String) {
        (format!("{:x}", self.sha256.finalize()), format!("hash_{:x}_{size}", self.legacy.finish()))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn stable_sha256_is_independent_of_read_chunks() {
        let mut a = ContentHasher::new(); a.update(b"abc");
        let mut b = ContentHasher::new(); b.update(b"a"); b.update(b"bc");
        let a = a.finish(3); let b = b.finish(3);
        assert_eq!(a.0, "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
        assert_eq!(a.0, b.0);
        // Legacy strings only match the historical 64 KiB read pattern; SHA256 is canonical.
    }
}

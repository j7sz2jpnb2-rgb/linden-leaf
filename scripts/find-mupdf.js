async function main() {
    try {
        const res = await fetch('https://github.com/ArtifexSoftware/mupdf/releases');
        const text = await res.text();
        const matches = text.match(/\/ArtifexSoftware\/mupdf\/releases\/download\/[^"'\s]+/g) || [];
        const unique = Array.from(new Set(matches));
        console.log("MuPDF Releases found:", unique);
    } catch (err) {
        console.error("Error fetching MuPDF releases:", err);
    }
}
main();

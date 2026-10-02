// scripts/make-pdf-with-outline.mjs
import { writeFileSync } from 'node:fs';

const pdf = `%PDF-1.4
1 0 obj
<<
  /Type /Catalog
  /Pages 2 0 R
  /Outlines 3 0 R
>>
endobj
2 0 obj
<<
  /Type /Pages
  /Kids [ 4 0 R 5 0 R ]
  /Count 2
>>
endobj
3 0 obj
<<
  /Type /Outlines
  /First 6 0 R
  /Last 7 0 R
  /Count 2
>>
endobj
6 0 obj
<<
  /Title (Chapter 1: Getting Started)
  /Parent 3 0 R
  /Next 7 0 R
  /Dest [ 4 0 R /XYZ 0 792 null ]
>>
endobj
7 0 obj
<<
  /Title (Chapter 2: Deep Dive)
  /Parent 3 0 R
  /Prev 6 0 R
  /Dest [ 5 0 R /XYZ 0 792 null ]
>>
endobj
4 0 obj
<<
  /Type /Page
  /Parent 2 0 R
  /MediaBox [ 0 0 612 792 ]
  /Contents 8 0 R
  /Resources <<
    /Font <<
      /F1 <<
        /Type /Font
        /Subtype /Type1
        /BaseFont /Helvetica
      >>
    >>
  >>
>>
endobj
5 0 obj
<<
  /Type /Page
  /Parent 2 0 R
  /MediaBox [ 0 0 612 792 ]
  /Contents 9 0 R
  /Resources <<
    /Font <<
      /F1 <<
        /Type /Font
        /Subtype /Type1
        /BaseFont /Helvetica
      >>
    >>
  >>
>>
endobj
8 0 obj
<<
  /Length 55
>>
stream
BT
/F1 24 Tf
72 700 Td
(Chapter 1: Getting Started) Tj
ET
endstream
endobj
9 0 obj
<<
  /Length 47
>>
stream
BT
/F1 24 Tf
72 700 Td
(Chapter 2: Deep Dive) Tj
ET
endstream
endobj
xref
0 10
0000000000 65535 f 
0000000009 00000 n 
0000000074 00000 n 
0000000133 00000 n 
0000000371 00000 n 
0000000543 00000 n 
0000000201 00000 n 
0000000289 00000 n 
0000000715 00000 n 
0000000821 00000 n 
trailer
<<
  /Size 10
  /Root 1 0 R
>>
startxref
919
%%EOF
`;

writeFileSync('D:\\LindenLeaf-Data\\test-pdfs\\outline-test.pdf', pdf);
console.log('Created outline-test.pdf successfully');

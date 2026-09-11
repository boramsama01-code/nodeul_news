# Runtime and dependency notices

The Windows package includes Node.js 24.19.0 and PostgreSQL 16.14 binaries.

- Node.js: https://nodejs.org/ — MIT and bundled third-party licenses; see runtime/NODE-LICENSE.txt.
- PostgreSQL: https://www.postgresql.org/about/licence/ — PostgreSQL License. The Windows binary distribution comes from @embedded-postgres/windows-x64@16.14.0-beta.17 on npm, based on zonkyio embedded-postgres-binaries. Its npm tarball SHA-512 integrity was verified before extraction. See runtime/POSTGRES-PACKAGE-LICENSE.md and bundled PostgreSQL files.
- Application dependencies are pinned in pnpm-lock.yaml in the source package. Their available license and notice files are included under licenses/ in the Windows package.

These components are independent of Replit and retain their respective copyrights and licenses.

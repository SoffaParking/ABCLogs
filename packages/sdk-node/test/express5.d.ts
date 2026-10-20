// `express5` is Express 5 installed under an alias, to test the middleware
// against both majors. Its API is the same where the tests touch it.
declare module 'express5' {
  import express from 'express';
  export default express;
}

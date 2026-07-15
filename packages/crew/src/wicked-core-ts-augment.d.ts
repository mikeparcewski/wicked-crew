// Augments the published wicked-core-ts 0.1.0 with fields added after that release
// but not yet published to npm. Remove this file once wicked-core-ts >= 0.1.1 is on npm.
export {};
declare module 'wicked-core-ts' {
  interface LaunchOptions {
    workflow?: string;
  }
}

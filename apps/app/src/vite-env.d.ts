/// <reference types="vite/client" />

import "react";

declare module "react" {
  interface IframeHTMLAttributes<T> {
    project?: boolean;
    workspace?: string;
  }

  interface InputHTMLAttributes<T> {
    webkitdirectory?: string;
    directory?: string;
  }
}

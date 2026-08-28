import "react";

// <elevenlabs-convai> is a web component, not a React component — declare it
// so TSX accepts the tag and its kebab-case attribute.
declare module "react" {
  namespace JSX {
    interface IntrinsicElements {
      "elevenlabs-convai": React.DetailedHTMLProps<React.HTMLAttributes<HTMLElement>, HTMLElement> & {
        "agent-id": string;
      };
    }
  }
}

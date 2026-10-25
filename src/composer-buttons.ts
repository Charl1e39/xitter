const BUTTON = ':is([data-xitter-sticker],[data-xitter-pay],[data-xitter-conversation])';
const ENABLED = `${BUTTON}:not(:disabled):not([aria-disabled="true"])`;

export const COMPOSER_BUTTON_CSS = `
${BUTTON},${BUTTON} *{background-color:transparent!important;transform:none!important;filter:none!important}
${BUTTON}{transition:background-color .2s ease!important}
${BUTTON} svg{transition:transform .15s ease!important;transform-origin:center}
@media(hover:hover){
${ENABLED}:hover{background-color:color-mix(in srgb,currentColor 10%,transparent)!important}
${ENABLED}:hover svg{transform:scale(1.12)!important}
}
${ENABLED}:focus-visible{background-color:color-mix(in srgb,currentColor 10%,transparent)!important;outline:2px solid currentColor;outline-offset:-2px}
${ENABLED}:active{background-color:color-mix(in srgb,currentColor 20%,transparent)!important}
${ENABLED}:active svg{transform:scale(.95)!important}
@media(prefers-reduced-motion:reduce){
${BUTTON},${BUTTON} svg{transition:none!important}
${ENABLED}:is(:hover,:active) svg{transform:none!important}
}
`;

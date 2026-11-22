import type { ReactElement, ForwardRefExoticComponent, RefAttributes, Component } from "react";
export declare function Button(props: { label: string }): ReactElement | null;
export declare const Input: ForwardRefExoticComponent<{ value: string } & RefAttributes<HTMLInputElement>>;
export declare class Card extends Component<{ title: string }> {}
export declare const Version: string;
export declare function Factory(props: { name: string }): Date;
export interface ButtonProps { label: string }

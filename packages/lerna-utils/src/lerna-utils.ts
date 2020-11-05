/**
 * lerna-utils
 * Internal utilities for interacting with a lerna monorepo
 */

import * as path from 'path'
import * as fs from 'fs'
import * as t from 'io-ts'
import * as A from 'fp-ts/Array'
import * as E from 'fp-ts/Either'
import * as O from 'fp-ts/Option'
import * as NEA from 'fp-ts/NonEmptyArray'
import * as F from 'fluture'
import * as most from 'most'
import Debug from 'debug'
import execa from 'execa'
import buffer from 'most-buffer'
import { pipe } from 'fp-ts/pipeable'
import { constant } from 'fp-ts/lib/function'
import { get } from 'shades'
import { LernaPackage } from '@typescript-tools/io-ts/dist/lib/LernaPackage'
import { StringifiedJSON } from '@typescript-tools/io-ts/dist/lib/StringifiedJSON'
import { docopt } from 'docopt'

const debug = {
    options: Debug('options')
}

export type DependencyGraph = { [packageName: string]: LernaPackage[] }

export const readFile = (file: fs.PathLike): F.FutureInstance<NodeJS.ErrnoException, string> =>
    F.node(done => fs.readFile(file, 'utf8', done))

export const writeFile = (file: fs.PathLike) => (contents: string): F.FutureInstance<NodeJS.ErrnoException, void> =>
    F.node(done => fs.writeFile(file, contents, done))

export const fromFuture = <L extends Error, R>(future: F.FutureInstance<L, R>): most.Stream<R> =>
    most.fromPromise(F.promise(future))

/* eslint-disable @typescript-eslint/no-explicit-any */
export function trace(
    logger: typeof console.log,
    ...tag: any[]
): <T>(value: T) => T {
    return function trace<T>(value: T): T {
        if (tag.length > 0) {
            logger(...tag, value)
        } else {
            logger(value)
        }
        return value
    }
}

// TODO: pull this into io-ts-types
export function withEncode<C extends t.Any, O>(
    codec: C,
    encode: (...a: Parameters<C['encode']>) => O,
    name: string = codec.name
): t.Type<C['_A'], O, C['_I']> {

    function clone<C extends t.Any>(t: C): C {
        const r = Object.create(Object.getPrototypeOf(t))
        Object.assign(r, t)
        return r
    }

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const r: any = clone(codec)
    r.encode = encode
    r.name = name
    return r
}

export function validationErrors(
  typeAlias: string,
  errors: t.Errors,
): string {
    /**
     * Inspired by
     * https://github.com/mmkal/ts/blob/94a9ba8f2931c9c91122d00b0bf1bd21b2be05cd/packages/io-ts-extra/src/reporters.ts#L11.
     */
    return errors.map((error) => {
        const name = typeAlias || error.context[0]?.type.name;
        const lastType = error.context.length && error.context[error.context.length - 1].type.name;
        const path = name + error.context.map((c) => c.key).join('.');
        return `Invalid value '${JSON.stringify(error.value)}' supplied to ${path}, expected ${lastType}.`;
    }).join('\n');
}

export function decodeCommandLineArguments<C extends t.Mixed>(
    codec: C,
    docstring: string,
    {
        input = process.argv.slice(2)
    }: {
        input?: string[]
    } = {}
): E.Either<t.Errors, C['_O']> {
    return pipe(
        input,
        argv => docopt(docstring, {argv, help: true, exit: true}),
        codec.decode.bind(null),
        E.map(codec.encode.bind(null)),
        E.map(trace(debug.options, 'Arguments'))
    )
}

/**
 * Get list of all lerna packages from `lerna list --all`.
 */
export function lernaPackages(
    root: string
): F.FutureInstance<unknown, LernaPackage[]> {
    return F.Future((reject, resolve) => {

        const subcommand = execa.command(
            'npx lerna list --all --json',
            { cwd: root }
        )

        subcommand
            .then(({ stdout }) => pipe(
                stdout,
                StringifiedJSON(t.array(LernaPackage)).decode.bind(null),
                E.fold(reject, resolve)
            ))
            .catch(reject)

        return function onCancel() {
            subcommand.cancel()
        }
    })
}

export function dependencyGraph(
    root: string
): F.FutureInstance<unknown, DependencyGraph> {

    const Dependencies = t.partial({
        dependencies: t.record(t.string, t.string),
        devDependencies: t.record(t.string, t.string),
        peerDependencies: t.record(t.string, t.string)
    })

    return lernaPackages(root)
        .pipe(F.chain(
            packages => F.attemptP(
                async () => most.from(packages)
                // parse each package's package.json file
                    .chain(
                        pkg => most.of(pkg.location)
                            .map(dir => path.resolve(dir, 'package.json'))
                            .map(readFile)
                            .chain(fromFuture)
                            .map(contents => pipe(
                                E.parseJSON(contents, E.toError),
                                E.mapLeft(error => `Unable to parse ${pkg.location}/package.json, ${error.message}`),
                                E.map(contents => ({pkg, contents}))
                            ))
                    )
                    .thru(buffer())
                // report all parse errors, if any
                    .chain(results => pipe(
                        NEA.fromArray(A.lefts(results)),
                        O.fold(
                            () => most.of(A.rights(results)),
                            // Nasty type assertion, but at least it'll complain if we change the type of the above line
                            failures => most.throwError(new Error([`Aborting, errors encountered:`].concat(failures).join('\n'))) as most.Stream<Array<{pkg: LernaPackage, contents: E.Json}>>
                        )
                    ))
                // map package's package.json file into a list of internal dependencies
                    .map(packages => {

                        // map of a package name to its metadata
                        const internalPackages = packages
                            .map(get('pkg'))
                            .reduce(
                                (acc, pkg) => Object.assign(acc, {[pkg.name]: pkg}),
                                {} as { [packageName: string]: LernaPackage }
                            )

                        // map of a package name to its internal dependencies
                        const internalDependencies = packages
                            .reduce(
                                (acc, {pkg, contents}) => Object.assign(
                                    acc,
                                    {
                                        [pkg.name]: pipe(
                                            Dependencies.decode(contents),
                                            E.map(contents => [
                                                ...Object.keys(contents.dependencies ?? {}),
                                                ...Object.keys(contents.devDependencies ?? {}),
                                                ...Object.keys(contents.peerDependencies ?? {}),
                                            ]),
                                            E.map(A.filter(dependency => internalPackages.hasOwnProperty(dependency))),
                                            E.getOrElse(constant([] as string[])),
                                            A.map(dependency => internalPackages[dependency])
                                        )
                                    }
                                ),
                                {} as { [packageName: string]: LernaPackage[] }
                            )

                        // Recursively list all internal dependencies, even transitive ones
                        const allInternalDependencies = (pkg: string): LernaPackage[] => {
                            const processed = new Set<string>()
                            const deps: LernaPackage[] = []
                            let next = internalDependencies[pkg]

                            do {
                                next.forEach(dependency => {
                                    processed.add(dependency.name)
                                    deps.push(dependency)
                                })
                                next = pipe(
                                    next,
                                    A.map(dependency => internalDependencies[dependency.name] ?? []),
                                    A.flatten,
                                    A.filter(dependency => !processed.has(dependency.name))
                                )
                            } while (!A.isEmpty(next))

                            return deps
                        }

                        return packages.reduce(
                            (acc, {pkg}) => Object.assign(
                                acc,
                                { [pkg.name]: allInternalDependencies(pkg.name) }
                            ),
                            {} as { [packageName: string]: LernaPackage[] }
                        )
                    })
                // stream only emits a single value
                    .reduce(
                        (_, value) => value,
                        {} as { [packageName: string]: LernaPackage[] }
                    )
            )
        ))
}
